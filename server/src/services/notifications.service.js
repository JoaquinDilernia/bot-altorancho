import crypto from 'crypto';
import { getDb } from './firebase.service.js';
import { sendWhatsAppTemplate } from './meta.service.js';
import { getOrderById } from './tiendanube.service.js';
import { getOrCreateConversation, appendMessage, updateMessageStatus } from './conversation.service.js';

const FOLLOWUP_COLLECTION = 'bot-altorancho_pickup_followups';
const DAY_MS = 24 * 60 * 60 * 1000;
// Mismos dos estados que se pueden elegir para el envío inicial (ver
// STATUS_FILTER_OPTIONS en Notifications.jsx) — si el pedido salió de estos
// estados ya no está "pendiente de retirar" y no tiene sentido insistir.
const PENDING_PICKUP_STATUSES = ['unpacked', 'unshipped'];

const TN_BASE = `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}`;
const TN_HEADERS = {
  Authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
  'User-Agent': 'BOT-ALTORANCHO/1.0',
};

const PICKUP_FIELDS = 'id,number,status,payment_status,shipping_status,shipping_pickup_type,shipping_option,shipping_pickup_details,customer,total,created_at';

// Branch keywords from the actual TiendaNube shipping option names
const BRANCH_KEYWORDS = ['SAN ISIDRO', 'BELGRANO', 'ALCORTA', 'NORDELTA', 'ALTORANCHO'];

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
  if (combined.includes('ALCORTA'))    return 'Alcorta';
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
    const bodyParams = (paramTemplate ?? []).map(tpl =>
      tpl
        .replace('{{name}}',   order.customer?.name ?? 'Cliente')
        .replace('{{number}}', String(order.number))
        .replace('{{branch}}', order.branch ?? '')
        .replace('{{total}}',  order.total ?? '')
    );

    // Registrar el envío en la conversación del cliente — antes esto se
    // mandaba directo a la API de Meta sin dejar rastro en el chat, así que
    // si el cliente se quejaba de una plantilla no había forma de ver cuál
    // se le mandó ni con qué datos.
    const msgId = crypto.randomUUID();
    const templateText = bodyParams.filter(Boolean).length > 0
      ? `[Plantilla: ${templateName}] ${bodyParams.join(' | ')}`
      : `[Plantilla: ${templateName}]`;

    try {
      await getOrCreateConversation(phone, 'whatsapp', order.customer?.name ?? null);
      await appendMessage(phone, { role: 'admin', content: templateText, msgId, msgStatus: 'sending' });

      let sendError = null;
      let waMsgId = null;
      try {
        waMsgId = await sendWhatsAppTemplate(phone, templateName, languageCode, bodyParams);
      } catch (sendErr) {
        sendError = sendErr;
      }
      await updateMessageStatus(phone, msgId, sendError ? 'error' : 'sent', waMsgId).catch(() => {});

      if (sendError) throw sendError;
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

  // Esta herramienta se usa únicamente para la notificación de retiro en
  // local — registrar cada envío exitoso para poder darle seguimiento
  // (recordatorios a los 3 y 7 días si el pedido sigue pendiente).
  try {
    await trackPickupFollowups(orders, results);
  } catch (err) {
    console.error('[notifications] Error registrando seguimiento de retiro:', err.message);
  }

  return { results, summary: { sent, errors, skipped } };
}

async function trackPickupFollowups(orders, results) {
  const db = getDb();
  const now = new Date();
  const batch = db.batch();
  let any = false;

  for (const order of orders) {
    const res = results.find(r => r.number === order.number);
    if (res?.status !== 'sent') continue;

    const ref = db.collection(FOLLOWUP_COLLECTION).doc(String(order.id));
    batch.set(ref, {
      orderId: order.id,
      orderNumber: order.number,
      phone: order.customer?.phone ?? null,
      customerName: order.customer?.name ?? null,
      branch: order.branch ?? null,
      total: order.total ?? null,
      initialSentAt: now,
      followup3SentAt: null,
      followup7SentAt: null,
      active: true,
      updatedAt: now,
    });
    any = true;
  }

  if (any) await batch.commit();
}

async function sendFollowupTemplate(record, tpl, paramTemplate) {
  if (!record.phone) throw new Error('Sin teléfono');
  const bodyParams = (paramTemplate ?? []).map(t =>
    t
      .replace('{{name}}',   record.customerName ?? 'Cliente')
      .replace('{{number}}', String(record.orderNumber))
      .replace('{{branch}}', record.branch ?? '')
      .replace('{{total}}',  record.total ?? '')
  );
  await sendWhatsAppTemplate(record.phone, tpl.name, tpl.language ?? 'es_AR', bodyParams);
  console.log(`[notifications] Followup "${tpl.name}" enviado a pedido #${record.orderNumber}`);
  return true;
}

/**
 * Cron diario: para cada pedido al que se le mandó la notificación de retiro,
 * si sigue pendiente de retirar (no cambió de estado en TiendaNube), manda un
 * recordatorio a los 3 días y otro a los 7 vía las plantillas configuradas.
 * Deja de insistir en cuanto el pedido cambia de estado o ya se mandaron
 * los recordatorios configurados.
 */
export async function sendPickupFollowups() {
  const db = getDb();

  const configDoc = await db.collection('bot-altorancho_config').doc('bot_config').get();
  const cfg = configDoc.exists ? configDoc.data() : {};
  if (!cfg.pickupFollowupEnabled) return;

  const day3Template = cfg.pickupFollowupDay3Template || null;
  const day7Template = cfg.pickupFollowupDay7Template || null;
  if (!day3Template && !day7Template) return;

  const templatesSnap = await db.collection('bot-altorancho_whatsapp_templates').get();
  const templatesByName = new Map(templatesSnap.docs.map(d => [d.data().name, d.data()]));

  const snap = await db.collection(FOLLOWUP_COLLECTION).where('active', '==', true).get();
  if (snap.empty) return;

  const now = Date.now();

  for (const doc of snap.docs) {
    const data = doc.data();
    const initialAt = data.initialSentAt?.toDate?.()?.getTime();
    if (!initialAt) continue;

    const elapsedDays = (now - initialAt) / DAY_MS;
    const need3 = !!day3Template && !data.followup3SentAt && elapsedDays >= 3;
    const need7 = !!day7Template && !data.followup7SentAt && elapsedDays >= 7;
    if (!need3 && !need7) continue;

    let order = null;
    try {
      order = await getOrderById(data.orderId);
    } catch { /* tratamos como no encontrado */ }

    const stillPending = order && PENDING_PICKUP_STATUSES.includes(order.shipping_status);
    if (!stillPending) {
      await doc.ref.update({ active: false, updatedAt: new Date() });
      continue;
    }

    const updates = { updatedAt: new Date() };

    if (need3) {
      const tpl = templatesByName.get(day3Template);
      if (tpl) {
        try {
          await sendFollowupTemplate(data, tpl, cfg.pickupFollowupDay3Params);
          updates.followup3SentAt = new Date();
        } catch (err) {
          console.error(`[notifications] Error en followup día 3 de #${data.orderNumber}:`, err.response?.data?.error?.message ?? err.message);
        }
      }
    }

    if (need7) {
      const tpl = templatesByName.get(day7Template);
      if (tpl) {
        try {
          await sendFollowupTemplate(data, tpl, cfg.pickupFollowupDay7Params);
          updates.followup7SentAt = new Date();
        } catch (err) {
          console.error(`[notifications] Error en followup día 7 de #${data.orderNumber}:`, err.response?.data?.error?.message ?? err.message);
        }
      }
    }

    const has3 = !day3Template || !!updates.followup3SentAt || !!data.followup3SentAt;
    const has7 = !day7Template || !!updates.followup7SentAt || !!data.followup7SentAt;
    if (has3 && has7) updates.active = false;

    await doc.ref.update(updates);
  }
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
