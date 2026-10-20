import crypto from 'crypto';
import axios from 'axios';
import { getDb } from './firebase.service.js';
import { sendWhatsAppTemplate } from './meta.service.js';
import { getPendingPaymentOrders } from './tiendanube.service.js';
import { createShortLink } from './campaign.service.js';
import { getOrCreateConversation, appendMessage, updateMessageStatus, markNotified } from './conversation.service.js';
import { toWaContactId } from './phone.js';
import {
  dueReminders, fillReminderParams, needsCvu, extractCvu, orderPageUrl,
  DEFAULT_FIRST_DELAY_MINUTES, DEFAULT_SECOND_HOUR,
} from './paymentReminder.js';

// Un doc por pedido (id = id interno de TiendaNube) con el resultado de cada
// paso: { first: {status, sentAt, ...}, second: {...} }. Sirve a la vez de
// candado (cada paso se intenta una sola vez) y de historial para el panel.
const COLLECTION = 'bot-altorancho_payment_reminders';
// El segundo recordatorio puede caer hasta ~42hs después de la compra
// (compra 00:00 → 9am del día siguiente + margen de 12hs).
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

let running = false;

async function getReminderConfig() {
  const doc = await getDb().collection('bot-altorancho_config').doc('bot_config').get();
  const cfg = doc.exists ? doc.data() : {};
  return {
    enabled: !!cfg.paymentReminderEnabled,
    firstTemplate: cfg.paymentReminderFirstTemplate || null,
    firstParams: cfg.paymentReminderFirstParams ?? [],
    firstDelayMinutes: Number(cfg.paymentReminderFirstDelayMinutes) || DEFAULT_FIRST_DELAY_MINUTES,
    secondTemplate: cfg.paymentReminderSecondTemplate || null,
    secondParams: cfg.paymentReminderSecondParams ?? [],
    secondHour: Number.isInteger(cfg.paymentReminderSecondHour) ? cfg.paymentReminderSecondHour : DEFAULT_SECOND_HOUR,
  };
}

// CVU exclusivo de Pago Nube para este pedido, leído de la página de la
// compra. null si no se pudo (la plantilla cae al texto de respaldo).
async function fetchOrderCvu(order) {
  const url = orderPageUrl(order);
  if (!url) return null;
  try {
    const { data } = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return extractCvu(data);
  } catch (err) {
    console.warn(`[payment-reminder] No se pudo leer el CVU del pedido #${order.number}:`, err.message);
    return null;
  }
}

// Manda un paso a un pedido y devuelve el resultado a guardar. Deja rastro en
// la conversación del cliente (mismo patrón que SimpliRoute/retiros) para que
// si responde, el agente vea qué se le mandó.
async function sendStep(order, templateName, paramTemplate, templatesByName) {
  const result = { templateName, sentAt: new Date() };
  const phone = toWaContactId(order.customer?.phone ?? '');
  if (!phone) return { ...result, status: 'skipped', reason: 'Sin teléfono' };

  const tpl = templatesByName.get(templateName);
  if (!tpl) return { ...result, status: 'error', reason: `Plantilla "${templateName}" no encontrada` };

  const cvu = needsCvu(paramTemplate) ? await fetchOrderCvu(order) : null;
  const bodyParams = fillReminderParams(paramTemplate, order, cvu);
  // Botón "Ver datos de pago": link corto propio (/r/<código>) a la página de
  // la compra — mismo mecanismo que los botones de las difusiones.
  const urlButtonParam = tpl.hasUrlButton
    ? await createShortLink({ targetUrl: orderPageUrl(order) ?? 'https://altorancho.com', campaignId: null, contactId: phone })
    : null;
  const msgId = crypto.randomUUID();
  try {
    await getOrCreateConversation(phone, 'whatsapp', order.customer?.name ?? null);
    await appendMessage(phone, {
      role: 'admin',
      content: `[Plantilla: ${templateName}] pedido #${order.number} pendiente de pago`,
      msgId,
      msgStatus: 'sending',
    });

    let waMsgId = null;
    let sendError = null;
    try {
      waMsgId = await sendWhatsAppTemplate(phone, templateName, tpl.language ?? 'es_AR', bodyParams, urlButtonParam);
    } catch (err) {
      sendError = err;
    }
    await updateMessageStatus(phone, msgId, sendError ? 'error' : 'sent', waMsgId).catch(() => {});
    if (sendError) throw sendError;

    await markNotified(phone);
    return { ...result, status: 'sent', phone, waMsgId: waMsgId ?? null, cvuFound: needsCvu(paramTemplate) ? !!cvu : null };
  } catch (err) {
    return { ...result, status: 'error', phone, reason: err.response?.data?.error?.message ?? err.message };
  }
}

/**
 * Cron (cada 10 min): recordatorio por WhatsApp a pedidos pagados por
 * transferencia (Pago Nube) que siguen pendientes de pago — uno a los N
 * minutos de la compra y otro al día siguiente a la hora configurada. La
 * lista de pendientes se trae fresca de TiendaNube en cada corrida, así que
 * si ya pagó (o venció la transferencia) no se le manda nada.
 */
export async function sendPaymentReminders() {
  if (running) return;
  running = true;
  try {
    const cfg = await getReminderConfig();
    if (!cfg.enabled || (!cfg.firstTemplate && !cfg.secondTemplate)) return;

    const now = Date.now();
    const orders = await getPendingPaymentOrders(new Date(now - LOOKBACK_MS));
    if (orders.length === 0) return;

    const db = getDb();
    const templatesSnap = await db.collection('bot-altorancho_whatsapp_templates').get();
    const templatesByName = new Map(templatesSnap.docs.map(d => [d.data().name, d.data()]));

    for (const order of orders) {
      const ref = db.collection(COLLECTION).doc(String(order.id));
      const snap = await ref.get();
      const record = snap.exists ? snap.data() : {};

      const steps = dueReminders(order, record, now, cfg);
      if (steps.length === 0) continue;

      const updates = {
        orderId: order.id,
        orderNumber: order.number,
        customerName: order.customer?.name ?? null,
        total: order.total ?? null,
        orderCreatedAt: order.created_at,
        updatedAt: new Date(),
      };
      // Si tocan los dos a la vez (raro: primer aviso demorado), alcanza con
      // uno — mandar dos plantillas seguidas es spam. Gana el segundo.
      const step = steps.includes('second') ? 'second' : 'first';
      const res = step === 'first'
        ? await sendStep(order, cfg.firstTemplate, cfg.firstParams, templatesByName)
        : await sendStep(order, cfg.secondTemplate, cfg.secondParams, templatesByName);
      updates[step] = res;
      if (step === 'second' && steps.includes('first')) {
        updates.first = { status: 'skipped', reason: 'Se mandó directo el segundo', sentAt: new Date() };
      }

      await ref.set(updates, { merge: true });
      console.log(`[payment-reminder] Pedido #${order.number} paso ${step}: ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
      await new Promise(r => setTimeout(r, 200)); // margen para no ráfagar la API de Meta
    }
  } finally {
    running = false;
  }
}

// Últimos pedidos a los que se les intentó mandar algún recordatorio.
export async function getPaymentReminderHistory(limit = 100) {
  const snap = await getDb().collection(COLLECTION).orderBy('updatedAt', 'desc').limit(limit).get();
  const iso = v => v?.toDate?.()?.toISOString() ?? v ?? null;
  return snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      updatedAt: iso(data.updatedAt),
      first: data.first ? { ...data.first, sentAt: iso(data.first.sentAt) } : null,
      second: data.second ? { ...data.second, sentAt: iso(data.second.sentAt) } : null,
    };
  });
}
