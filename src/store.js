import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const conversations = new Map();
const seenIds = new Set();

export function alreadySeen(id) {
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  if (seenIds.size > 5000) seenIds.clear();
  return false;
}

export function getHistory(phone) {
  return conversations.get(phone) || [];
}

export function saveTurn(phone, userText, botText) {
  const h = [...getHistory(phone), { role: 'user', content: userText }, { role: 'assistant', content: botText }];
  conversations.set(phone, h.slice(-16));
}

// ==========================================
// ORDER DATABASE OPERATIONS
// ==========================================

export async function saveOrder(order) {
  return await prisma.order.create({
    data: {
      orderId: order.orderId,
      phone: order.phone,
      lines: order.lines,
      total: order.total,
      address: order.address,
      name: order.name,
      status: order.status,
      checkoutId: order.checkoutId,
      receipt: order.receipt
    }
  });
}

export async function getOrder(id) {
  return await prisma.order.findUnique({
    where: { orderId: id }
  });
}

export async function allOrders() {
  return await prisma.order.findMany({
    orderBy: { createdAt: 'desc' }
  });
}

export async function findByCheckoutId(id) {
  return await prisma.order.findFirst({
    where: { checkoutId: id }
  });
}

export async function updateOrderStatus(orderId, status, receipt = null, checkoutId = null) {
  const data = { status };
  if (receipt) data.receipt = receipt;
  if (checkoutId) data.checkoutId = checkoutId;

  return await prisma.order.update({
    where: { orderId: orderId },
    data: data
  });
}

// ==========================================
// MENU DATABASE OPERATIONS
// ==========================================

export async function getAllMenuItems() {
  return await prisma.menuItem.findMany({
    orderBy: { name: 'asc' }
  });
}

export async function getAvailableMenuItems() {
  return await prisma.menuItem.findMany({
    where: { available: true }
  });
}

export async function addMenuItem(data) {
  return await prisma.menuItem.upsert({
    where: { itemId: data.itemId },
    update: {
      name: data.name,
      price: data.price,
    },
    create: {
      itemId: data.itemId,
      name: data.name,
      price: data.price,
      businessId: data.businessId || 'mama-pendo'
    }
  });
}

export async function toggleItemAvailability(itemId, currentStatus) {
  return await prisma.menuItem.update({
    where: { itemId },
    data: { available: !currentStatus }
  });
}