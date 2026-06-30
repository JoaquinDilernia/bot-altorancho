import axios from 'axios';
import { getDb } from './firebase.service.js';
import { sendWhatsAppTemplate } from './meta.service.js';

const TN_BASE = `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}`;
const TN_HEADERS = {
  Authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
  'User-Agent': 'BOT-ALTORANCHO/1.0',
};

const PICKUP_FIELDS = 'id,number,status,payment_status,shipping_status,shipping_pickup_type,shipping_option,customer,products,created_at';

// Local branch names for Alto Rancho
const STORES = [
  { key: 'Belgrano',  keywords: ['belgrano'] },
  { key: 'Las Lomas', keywords: ['lomas'] },
  { key: 'Alcorta',   keywords: ['alcorta', 'light studio'] },
];

// Normalizes Argentine mobile numbers to E.164 without '+' for the WhatsApp API.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).trim().replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('54') && d.length >= 12) return d;
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('9') && d.length === 11) return `54${d}`;
  if (d.length === 10) return `549${d}`;
  if (d.length === 8) return `5411${d}`; // CABA landline fallback, rarely useful
  return null;
}

// TiendaNube may return shipping_option as a plain string or as { name, ... }
function shippingOptionName(order) {
  const raw = order.shipping_option;
  if (!raw) return '';
  return typeof raw === 'string' ? raw : (raw.name ?? '');
}

function isPickupOrder(order) {
  if (order.shipping_pickup_type) return true;
  const name = shippingOptionName(order).toLowerCase();
  return (
    name.includes('retiro') ||
    name.includes('pickup') ||
    name.includes('local') ||
    name.includes('sucursal') ||
    name.includes('tienda')
  );
}

function extractStore(order) {
  const name = shippingOptionName(order).toLowerCase();
  for (const store of STORES) {
    if (store.keywords.some(kw => name.includes(kw))) return store.key;
  }
  return null;
}

function extractProducts(order) {
  return (order.products ?? [])
    .map(p => {
      const name = typeof p.name === 'string' ? p.name
        : (p.name?.es ?? p.name?.en ?? Object.values(p.name ?? {})[0] ?? 'Producto');
      return `${name} x${p.quantity ?? 1}`;
    })
    .join(', ');
}

export async function getPickupReadyOrders({ store } = {}) {
  // "fulfilling" = being packed. "shipped" = ready for pickup in TiendaNube's pickup flow.
  const params = {
    fields: PICKUP_FIELDS,
    payment_status: 'paid',
    per_page: 200,
    sort_by: 'created_at',
    sort_direction: 'desc',
  };

  const results = await Promise.allSettled([
    axios.get(`${TN_BASE}/orders`, { headers: TN_HEADERS, params: { ...params, shipping_status: 'fulfilling' } }),
    axios.get(`${TN_BASE}/orders`, { headers: TN_HEADERS, params: { ...params, shipping_status: 'shipped' } }),
  ]);

  const seen = new Set();
  const orders = [];

  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[notifications] TiendaNube fetch error:', r.reason?.message);
      continue;
    }
    for (const order of r.value.data ?? []) {
      if (seen.has(order.id)) continue;
      seen.add(order.id);
      if (!isPickupOrder(order)) continue;

      const orderStore = extractStore(order);
      if (store && orderStore !== store) continue;

      const phone = normalizePhone(order.customer?.phone);
      orders.push({
        id: order.id,
        number: order.number,
        customerName: order.customer?.name ?? 'Cliente',
        phone,
        hasPhone: !!phone,
        store: orderStore,
        products: extractProducts(order),
        shippingStatus: order.shipping_status,
        createdAt: order.created_at,
      });
    }
  }

  return orders;
}

export async function sendBulkNotification({ templateName, language = 'es_AR', variables, recipients, sentBy }) {
  // variables: array of field names per position, e.g. ['customerName', 'orderNumber']
  // recipients: array of { phone, orderNumber, customerName }

  const results = { sent: 0, failed: 0, skipped: 0, details: [] };

  for (const r of recipients) {
    if (!r.phone) {
      results.skipped++;
      results.details.push({ orderNumber: r.orderNumber, status: 'skipped', reason: 'Sin teléfono' });
      continue;
    }

    const params = variables.map(field => {
      if (field === 'orderNumber') return String(r.orderNumber);
      if (field === 'customerName') return r.customerName?.split(' ')[0] ?? 'Cliente';
      if (field === 'storeName') return 'Alto Rancho';
      return field; // literal fallback
    });

    try {
      await sendWhatsAppTemplate(r.phone, templateName, language, params);
      results.sent++;
      results.details.push({ orderNumber: r.orderNumber, phone: r.phone, status: 'sent' });
    } catch (err) {
      results.failed++;
      const reason = err.response?.data?.error?.message ?? err.message;
      results.details.push({ orderNumber: r.orderNumber, phone: r.phone, status: 'failed', reason });
    }

    // Rate-limit: WhatsApp allows ~80 template messages/sec, but 50ms gap is safe
    await new Promise(res => setTimeout(res, 50));
  }

  // Persist log to Firestore
  try {
    const db = getDb();
    await db.collection('bot-altorancho_notifications').add({
      sentAt: new Date(),
      sentBy: sentBy ?? 'admin',
      templateName,
      language,
      variables,
      totalSent: results.sent,
      totalFailed: results.failed,
      totalSkipped: results.skipped,
      details: results.details,
    });
  } catch (err) {
    console.error('[notifications] Error logging to Firestore:', err.message);
  }

  return results;
}

export async function getNotificationHistory() {
  const db = getDb();
  const snap = await db.collection('bot-altorancho_notifications')
    .orderBy('sentAt', 'desc')
    .limit(20)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data(), sentAt: d.data().sentAt?.toDate?.()?.toISOString() ?? d.data().sentAt }));
}
