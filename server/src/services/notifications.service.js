import { getDb } from './firebase.service.js';
import { sendWhatsAppTemplate } from './meta.service.js';

const TN_BASE = `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}`;
const TN_HEADERS = {
  Authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
  'User-Agent': 'BOT-ALTORANCHO/1.0',
};

const PICKUP_FIELDS = 'id,number,status,payment_status,shipping_status,shipping_pickup_type,shipping_option,shipping_pickup_details,customer,total,created_at';

// Branch keywords from the actual TiendaNube shipping option names
const BRANCH_KEYWORDS = ['SAN ISIDRO', 'BELGRANO', 'NORDELTA', 'ALTORANCHO'];

function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).trim().replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('54') && d.length >= 12) return d;
  if (d.startsWith('0')) return `549${d.slice(1)}`;
  if (d.startsWith('15')) return `5491${d.slice(2)}`;
  if (d.length === 10) return `549${d}`;
  return d;
}

function isPickupOrder(order) {
  if (order.shipping_pickup_type === 'pickup' || order.shipping_pickup_type === 'ship_to_store') return true;
  // shipping_option is a plain STRING in TiendaNube (not an object)
  const option = (order.shipping_option ?? '').toUpperCase();
  const detail = (order.shipping_pickup_details?.name ?? '').toUpperCase();
  return BRANCH_KEYWORDS.some(k => option.includes(k) || detail.includes(k));
}

function extractBranch(order) {
  const option = (order.shipping_option ?? '').toUpperCase();
  const detail = (order.shipping_pickup_details?.name ?? '').toUpperCase();
  const combined = `${option} ${detail}`;
  if (combined.includes('SAN ISIDRO')) return 'San Isidro';
  if (combined.includes('BELGRANO'))   return 'Belgrano';
  if (combined.includes('NORDELTA'))   return 'Nordelta';
  // Fallback: return the raw option name so it's still readable
  return order.shipping_option || order.shipping_pickup_details?.name || 'Sucursal';
}

/**
 * Fetches all recent pickup orders from TiendaNube.
 * Does NOT filter by shipping_status at the API level — TiendaNube's pickup
 * status values (especially 'unshipped' = ready for pickup) don't map
 * reliably to the shipping_status API filter. We fetch all and filter client-side.
 */
export async function getPickupOrders() {
  const { default: axios } = await import('axios');
  const allOrders = [];

  // Fetch last 10 pages (500 orders) — enough for any active store
  for (let page = 1; page <= 10; page++) {
    try {
      const { data } = await axios.get(`${TN_BASE}/orders`, {
        headers: TN_HEADERS,
        params: { fields: PICKUP_FIELDS, per_page: 50, page },
      });
      if (!data?.length) break;
      allOrders.push(...data);
      if (data.length < 50) break;
    } catch (err) {
      console.error('[notifications] TiendaNube fetch error page', page, err.message);
      break;
    }
  }

  console.log('[notifications] fetched', allOrders.length, 'total orders from TiendaNube');

  const pickupOrders = allOrders.filter(isPickupOrder);
  console.log('[notifications] pickup orders detected:', pickupOrders.length);

  if (pickupOrders.length > 0) {
    const s = pickupOrders[0];
    console.log('[notifications] sample:', {
      number: s.number,
      shipping_status: s.shipping_status,
      shipping_pickup_type: s.shipping_pickup_type,
      shipping_option: s.shipping_option,
      shipping_pickup_details: s.shipping_pickup_details,
    });
  }

  pickupOrders.sort((a, b) => a.number - b.number);

  return pickupOrders.map(o => ({
    id: o.id,
    number: o.number,
    status: o.status,
    paymentStatus: o.payment_status,
    shippingStatus: o.shipping_status,
    branch: extractBranch(o),
    customer: {
      name: o.customer?.name ?? 'Cliente',
      email: o.customer?.email ?? null,
      phone: normalizePhone(o.customer?.phone ?? ''),
    },
    total: o.total,
    createdAt: o.created_at,
  }));
}

/**
 * Send bulk WhatsApp template with per-order param interpolation.
 * paramTemplate: array of strings, each may contain {{name}}, {{number}}, {{branch}}, {{total}}
 */
export async function sendBulkOrders({ orders, templateName, languageCode, paramTemplate, sentBy }) {
  const results = [];

  for (const order of orders) {
    const phone = order.customer?.phone;
    if (!phone) {
      results.push({ number: order.number, status: 'skipped', reason: 'Sin teléfono' });
      continue;
    }
    try {
      const bodyParams = (paramTemplate ?? []).map(tpl =>
        tpl
          .replace('{{name}}',   order.customer?.name ?? 'Cliente')
          .replace('{{number}}', String(order.number))
          .replace('{{branch}}', order.branch ?? '')
          .replace('{{total}}',  order.total ?? '')
      );
      await sendWhatsAppTemplate(phone, templateName, languageCode, bodyParams);
      results.push({ number: order.number, status: 'sent', phone });
    } catch (err) {
      const reason = err.response?.data?.error?.message ?? err.message;
      results.push({ number: order.number, status: 'error', reason });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  const sent    = results.filter(r => r.status === 'sent').length;
  const errors  = results.filter(r => r.status === 'error').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  try {
    await getDb().collection('bot-altorancho_notifications').add({
      sentAt: new Date(),
      sentBy: sentBy ?? 'admin',
      templateName,
      languageCode,
      totalSent: sent,
      totalErrors: errors,
      totalSkipped: skipped,
      results,
    });
  } catch (err) {
    console.error('[notifications] Firestore log error:', err.message);
  }

  return { results, summary: { sent, errors, skipped } };
}

export async function getNotificationHistory() {
  const db = getDb();
  const snap = await db.collection('bot-altorancho_notifications')
    .orderBy('sentAt', 'desc')
    .limit(20)
    .get();
  return snap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    sentAt: d.data().sentAt?.toDate?.()?.toISOString() ?? d.data().sentAt,
  }));
}
