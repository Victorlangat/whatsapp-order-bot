import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import basicAuth from 'express-basic-auth'; // NEW: Security package
import menu from './menu.js'; 
import { reply } from './llm.js';
import { sendText } from './whatsapp.js';
import { stkPush } from './mpesa.js';
import { 
  alreadySeen, getHistory, saveTurn, saveOrder, getOrder, allOrders, 
  findByCheckoutId, updateOrderStatus, addMenuItem, 
  getAllMenuItems, getAvailableMenuItems, toggleItemAvailability 
} from './store.js';

const app = express();

// CRITICAL SECURITY: Capture the raw body for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true })); 

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// --- DASHBOARD AUTHENTICATION ---
// Protects both the dashboard UI and the admin API routes
const dashboardAuth = basicAuth({
  users: { 'admin': 'mama2026' }, // Change this to your own secure username/password
  challenge: true,
  unauthorizedResponse: 'Access Denied. Please log in.'
});
app.use('/dashboard', dashboardAuth);
app.use('/admin', dashboardAuth);

// --- SECURITY: Webhook Signature Verification ---
function verifySignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  
  // If secret is missing, skip check (only for local testing)
  if (!appSecret) {
    console.warn("⚠️ WHATSAPP_APP_SECRET is missing. Security is OFF.");
    return true; 
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;

  // CRITICAL: Use req.rawBody instead of JSON.stringify(req.body)
  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody) 
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

// --- ORDER LOGIC ---
async function placeOrder(phone, input) {
  const lines = [];
  let total = 0;
  
  // BACKEND GUARDRAIL: Only fetch items that are IN STOCK
  const availableMenu = await getAvailableMenuItems();

  for (const it of input.items || []) {
    const m = availableMenu.find((x) => x.itemId === it.id); 
    if (!m) return { ok: false, error: 'Item is out of stock or unknown: ' + it.id };
    
    const qty = Math.max(1, Math.min(20, parseInt(it.qty, 10) || 1));
    lines.push({ id: m.itemId, name: m.name, qty, price: m.price });
    total += m.price * qty;
  }
  if (!lines.length) return { ok: false, error: 'No items in order' };

  const orderId = crypto.randomBytes(3).toString('hex').toUpperCase();
  const order = {
    orderId,
    phone,
    lines,
    total,
    address: input.delivery_address || '',
    name: input.customer_name || '',
    status: 'PENDING_PAYMENT',
  };
  
  await saveOrder(order);
  
  try {
    const r = await stkPush({ phone, amount: total, orderId });
    await updateOrderStatus(orderId, 'PENDING_PAYMENT', null, r.CheckoutRequestID); 
    return { ok: true, orderId, total, note: 'M-Pesa prompt sent to the customer phone' };
  } catch (e) {
    console.error(e.message);
    await updateOrderStatus(orderId, 'PAYMENT_ERROR'); 
    return { ok: false, error: 'Could not send the M-Pesa prompt' };
  }
}

async function markPaid(order, receipt) {
  if (order.status === 'PAID') return;
  await updateOrderStatus(order.orderId, 'PAID', receipt);
  await sendText(order.phone, `Payment received! Receipt ${receipt}. Order #${order.orderId} is being prepared. Asante!`);
}

// --- UPDATED: HandleText with Human Handoff ---
async function handleText(phone, text) {
  const answer = await reply(
    getHistory(phone), 
    text, 
    (input) => placeOrder(phone, input), // Tool 1: Place Order
    async (reason) => {                  // Tool 2: Human Handoff
      console.log(`🚨 HUMAN HANDOFF REQUESTED for ${phone}. Reason: ${reason}`);
      return { ok: true, note: 'Tell the customer a human will be with them shortly. Apologize for the wait.' };
    }
  );
  saveTurn(phone, text, answer);
  return answer;
}

// --- WHATSAPP WEBHOOKS ---
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) {
    console.error('❌ Invalid webhook signature! Ignoring request.');
    return res.sendStatus(403);
  }
  res.sendStatus(200); 
  onWebhook(req.body).catch((e) => console.error('webhook error', e));
});

async function onWebhook(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg || alreadySeen(msg.id)) return;
  const from = msg.from;
  if (msg.type !== 'text') {
    await sendText(from, 'Sorry, I can only read text messages for now. Please type your order.');
    return;
  }
  try {
    const answer = await handleText(from, msg.text.body);
    await sendText(from, answer);
  } catch (e) {
    console.error(e);
    await sendText(from, 'Sorry, I am having trouble right now. Please try again in a moment.');
  }
}

// --- MPESA CALLBACK ---
app.post('/mpesa/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const cb = req.body?.Body?.stkCallback;
  if (!cb) return;
  
  const order = await findByCheckoutId(cb.CheckoutRequestID); 
  if (!order) return;
  
  if (cb.ResultCode === 0) {
    const items = cb.CallbackMetadata?.Item || [];
    const receipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value || 'N/A';
    await markPaid(order, receipt);
  } else {
    await updateOrderStatus(order.orderId, 'PAYMENT_FAILED'); 
    await sendText(order.phone, `We did not receive payment for order #${order.orderId} (${cb.ResultDesc}). Send your order again to retry.`);
  }
});

// --- ADMIN ROUTES ---
app.post('/admin/add-item', async (req, res) => {
  try {
    const { name, price, itemId } = req.body;
    await addMenuItem({ 
      name, 
      price: parseFloat(price), 
      itemId: itemId.toLowerCase().replace(/\s+/g, '-') 
    });
    res.redirect('/dashboard');
  } catch (e) {
    res.status(500).send('Error adding item: ' + e.message);
  }
});

app.post('/admin/toggle-item/:id', async (req, res) => {
  const { id } = req.params;
  const { current } = req.body;
  try {
    await toggleItemAvailability(id, current === 'true');
    res.redirect('/dashboard');
  } catch (e) {
    res.status(500).send('Error toggling item: ' + e.message);
  }
});

app.post('/admin/update-status/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  try {
    await updateOrderStatus(id, status);
    
    const order = await getOrder(id);
    if (order) {
      let message = '';
      if (status === 'READY') message = `Good news! Your order #${id} is ready.`;
      if (status === 'OUT_FOR_DELIVERY') message = `Your order #${id} is on the way!`;
      
      if (message) await sendText(order.phone, message);
    }
    res.redirect('/dashboard');
  } catch (e) {
    res.status(500).send('Error updating status: ' + e.message);
  }
});

// --- DASHBOARD UI ---
app.get('/dashboard', async (_req, res) => { 
  const orders = await allOrders(); 
  const menuItems = await getAllMenuItems();

  // 1. Stats
  const today = new Date().toDateString();
  const todayOrders = orders.filter(o => new Date(o.createdAt).toDateString() === today);
  const totalRevenue = orders.filter(o => o.status === 'PAID').reduce((sum, o) => sum + o.total, 0);
  const pendingCount = orders.filter(o => o.status === 'PENDING_PAYMENT').length;

  // 2. Menu Table HTML
  const menuRows = menuItems.map((item) => `
    <tr class="border-b border-gray-200 hover:bg-gray-50">
      <td class="px-4 py-3 text-sm text-gray-900 font-medium">${esc(item.name)} <span class="text-gray-400 text-xs ml-1">(${esc(item.itemId)})</span></td>
      <td class="px-4 py-3 text-sm text-gray-900">KES ${esc(item.price)}</td>
      <td class="px-4 py-3">
        <span class="px-2 py-1 rounded text-xs font-semibold ${item.available ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
          ${item.available ? 'IN STOCK' : 'OUT OF STOCK'}
        </span>
      </td>
      <td class="px-4 py-3">
        <form action="/admin/toggle-item/${item.itemId}" method="POST">
          <input type="hidden" name="current" value="${item.available}">
          <button type="submit" class="text-sm font-medium px-3 py-1 rounded ${item.available ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-green-50 text-green-600 hover:bg-green-100'}">
            Mark as ${item.available ? 'Out of Stock' : 'In Stock'}
          </button>
        </form>
      </td>
    </tr>
  `).join('');

  // 3. Orders Table HTML (With Status Update Form)
  const orderRows = orders.map((o) => {
    let badgeColor = 'bg-yellow-100 text-yellow-800';
    if (o.status === 'PAID') badgeColor = 'bg-green-100 text-green-800';
    if (o.status === 'READY') badgeColor = 'bg-blue-100 text-blue-800';
    if (o.status === 'OUT_FOR_DELIVERY') badgeColor = 'bg-purple-100 text-purple-800';
    if (o.status === 'PAYMENT_ERROR' || o.status === 'PAYMENT_FAILED') badgeColor = 'bg-red-100 text-red-800';

    let actionHtml = '';
    if (['PAID', 'READY', 'OUT_FOR_DELIVERY'].includes(o.status)) {
      actionHtml = `
        <form action="/admin/update-status/${o.orderId}" method="POST" class="mt-2 flex gap-1">
          <select name="status" class="text-xs border border-gray-300 rounded p-1">
            <option value="PAID" ${o.status === 'PAID' ? 'selected' : ''}>Paid</option>
            <option value="READY" ${o.status === 'READY' ? 'selected' : ''}>Ready</option>
            <option value="OUT_FOR_DELIVERY" ${o.status === 'OUT_FOR_DELIVERY' ? 'selected' : ''}>Out for Delivery</option>
            <option value="COMPLETED" ${o.status === 'COMPLETED' ? 'selected' : ''}>Completed</option>
          </select>
          <button type="submit" class="text-xs bg-gray-800 text-white px-2 py-1 rounded hover:bg-gray-900">Update</button>
        </form>
      `;
    }

    return `
    <tr class="hover:bg-gray-50 border-b border-gray-200">
      <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">#${esc(o.orderId)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${esc(o.phone)}</td>
      <td class="px-6 py-4 text-sm text-gray-900">${esc(o.lines.map((l) => l.qty + ' x ' + l.name).join(', '))}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-semibold">KES ${esc(o.total)}</td>
      <td class="px-6 py-4 whitespace-nowrap">
        <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${badgeColor}">
          ${esc(o.status)}
        </span>
        ${actionHtml}
      </td>
    </tr>`;
  }).join('');

  // 4. Send HTML
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Dashboard | ${esc(menu.business)}</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 font-sans antialiased">
      
      <nav class="bg-white shadow-sm border-b border-gray-200">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="flex justify-between h-16 items-center">
            <h1 class="text-xl font-bold text-gray-800">🍽️ ${esc(menu.business)}</h1>
            <span class="text-sm text-gray-500">Admin Dashboard</span>
          </div>
        </div>
      </nav>

      <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        <!-- Stat Cards -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div class="bg-white rounded-lg shadow p-6 border-l-4 border-blue-500">
            <h3 class="text-sm font-medium text-gray-500 uppercase tracking-wide">Orders Today</h3>
            <p class="mt-2 text-3xl font-bold text-gray-900">${todayOrders.length}</p>
          </div>
          <div class="bg-white rounded-lg shadow p-6 border-l-4 border-green-500">
            <h3 class="text-sm font-medium text-gray-500 uppercase tracking-wide">Total Revenue (Paid)</h3>
            <p class="mt-2 text-3xl font-bold text-gray-900">KES ${totalRevenue}</p>
          </div>
          <div class="bg-white rounded-lg shadow p-6 border-l-4 border-yellow-500">
            <h3 class="text-sm font-medium text-gray-500 uppercase tracking-wide">Pending Payments</h3>
            <p class="mt-2 text-3xl font-bold text-gray-900">${pendingCount}</p>
          </div>
        </div>

        <!-- Add Menu Item Form -->
        <div class="bg-white rounded-lg shadow p-6 mb-8">
          <h3 class="text-lg leading-6 font-medium text-gray-900 mb-4">Add New Menu Item</h3>
          <form action="/admin/add-item" method="POST" class="flex flex-col md:flex-row gap-4 items-end">
            <div class="flex-1 w-full">
              <label class="block text-sm font-medium text-gray-700">Item Name</label>
              <input type="text" name="name" placeholder="e.g. Chicken Pizza" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
            </div>
            <div class="w-full md:w-32">
              <label class="block text-sm font-medium text-gray-700">Price (KES)</label>
              <input type="number" name="price" placeholder="800" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
            </div>
            <div class="flex-1 w-full">
              <label class="block text-sm font-medium text-gray-700">Item ID (no spaces)</label>
              <input type="text" name="itemId" placeholder="chicken-pizza" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
            </div>
            <button type="submit" class="w-full md:w-auto bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 font-medium shadow-sm">Add Item</button>
          </form>
        </div>

        <!-- Menu Management Table -->
        <div class="bg-white rounded-lg shadow mb-8 overflow-hidden">
          <div class="px-6 py-5 border-b border-gray-200 bg-gray-50">
            <h3 class="text-lg leading-6 font-medium text-gray-900">Menu Management (Inventory)</h3>
          </div>
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-white">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Item</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Price</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              ${menuRows.length > 0 ? menuRows : '<tr><td colspan="4" class="px-6 py-4 text-center text-gray-500">No items in menu. Add one above.</td></tr>'}
            </tbody>
          </table>
        </div>

        <!-- Orders Table -->
        <div class="bg-white shadow rounded-lg overflow-hidden">
          <div class="px-6 py-5 border-b border-gray-200 bg-gray-50">
            <h3 class="text-lg leading-6 font-medium text-gray-900">Recent Orders</h3>
          </div>
          <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-white">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Phone</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Items</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                ${orderRows.length > 0 ? orderRows : '<tr><td colspan="5" class="px-6 py-10 text-center text-gray-500">No orders yet. Send a WhatsApp message to get started!</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </body>
    </html>
  `);
});

// --- DEV HELPERS ---
if (process.env.DEV_MODE === 'true') {
  app.get('/dev/chat', async (req, res) => {
    try {
      const answer = await handleText(req.query.phone || '254700000000', String(req.query.text || ''));
      res.send(answer);
    } catch (e) {
      res.status(500).send('Error: ' + e.message);
    }
  });

  app.get('/dev/pay/:id', async (req, res) => { 
    const o = await getOrder(req.params.id.toUpperCase()); 
    if (!o) return res.status(404).send('No such order');
    await markPaid(o, 'DEMO' + o.orderId);
    res.send('Marked as paid');
  });
}

app.listen(process.env.PORT || 3000, () => console.log('Server running on port ' + (process.env.PORT || 3000)));