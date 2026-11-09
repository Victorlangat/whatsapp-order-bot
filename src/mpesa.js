const BASE = 'https://sandbox.safaricom.co.ke';

function normalizePhone(p) {
  const d = String(p).replace(/[^0-9]/g, '');
  if (d.startsWith('0')) return '254' + d.slice(1);
  if (d.startsWith('7') || d.startsWith('1')) return '254' + d;
  return d;
}

async function getToken() {
  const auth = Buffer.from(`${process.env.DARAJA_KEY}:${process.env.DARAJA_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error('Daraja token failed: ' + r.status + ' ' + (await r.text()));
  return (await r.json()).access_token;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function stkPush({ phone, amount, orderId }) {
  const token = await getToken();
  const ts = timestamp();
  const shortcode = process.env.DARAJA_SHORTCODE;
  const password = Buffer.from(shortcode + process.env.DARAJA_PASSKEY + ts).toString('base64');
  const msisdn = normalizePhone(process.env.STK_TEST_PHONE || phone);
  const body = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: msisdn,
    PartyB: shortcode,
    PhoneNumber: msisdn,
    CallBackURL: `${process.env.PUBLIC_URL}/mpesa/callback`,
    AccountReference: orderId,
    TransactionDesc: 'Order',
  };
  const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || data.ResponseCode !== '0') throw new Error('STK push failed: ' + JSON.stringify(data));
  return data;
}
