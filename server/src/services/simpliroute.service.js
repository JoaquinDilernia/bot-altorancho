import crypto from 'crypto';
import { getDb } from './firebase.service.js';
import { sendWhatsAppTemplate } from './meta.service.js';
import { findOrder } from './tiendanube.service.js';
import { findOdooOrder, getPartnerContact } from './odoo.service.js';
import { getOrCreateConversation, appendMessage, updateMessageStatus, markNotified } from './conversation.service.js';
import { normalizePhone } from './notifications.service.js';

const HISTORY_COLLECTION = 'bot-altorancho_simpliroute_notifications';

// URL del seguimiento en vivo de SimpliRoute. El código es el "ID de
// referencia" de la visita, que Alto Rancho llena con el número de pedido
// (opción "Link de Id de seguimiento" activada). Verificado en el panel:
// Comunicaciones → widget de Live Tracking. Cuenta 100457 = Alto Rancho.
const TRACKING_URL_BASE = 'https://livetracking.simpliroute.com/widget/account/100457/tracking/';

// Plantillas de WhatsApp que dispara este webhook — deben existir y estar
// aprobadas en Meta (panel de Notificaciones) antes de que esto pueda enviar.
// v2: la primera ("pedido_en_camino") quedó atascada en PENDING en Meta
// varias horas más que sus hermanas del mismo lote — se recreó sin emoji
// bajo otro nombre técnico en vez de esperarla indefinidamente.
const TEMPLATE_ON_ROUTE = 'pedido_en_camino_v2';
const TEMPLATE_DELIVERED = 'pedido_entregado';
const TEMPLATE_FAILED = 'pedido_no_entregado';

const SUCCESS_VALUES = new Set(['success', 'successful', 'exitoso', 'delivered', 'completed', 'complete']);
const FAILED_VALUES = new Set(['failed', 'failure', 'fallido', 'undelivered', 'unsuccessful']);

export function verifySimpliRouteToken(req) {
  const expected = process.env.SIMPLIROUTE_WEBHOOK_TOKEN;
  if (!expected) return false;
  const header = req.headers['x-simpliroute-token'] ?? req.headers['authorization'];
  if (!header) return false;
  const value = header.startsWith('token ') ? header.slice(6).trim() : header.trim();
  return value === expected;
}

// SimpliRoute no documenta un shape fijo para esta cuenta — en vez de asumir
// una ruta exacta, buscamos las claves candidatas en profundidad. Si el
// primer evento real trae otro shape, ajustar las listas de keys acá
// (revisar el payload completo que queda logueado más abajo).
function deepFind(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = deepFind(val, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// Busca, en cualquier profundidad, el primer array de objetos que "parecen"
// visitas (tienen title o algún campo de referencia). Usado para el evento
// de inicio de ruta, que trae la lista completa de paradas del día.
function findVisitsArray(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  if (Array.isArray(obj)) {
    const looksLikeVisits = obj.length > 0 && obj.every(
      o => o && typeof o === 'object' && (o.title || o.reference_id || o.reference || o.visit)
    );
    return looksLikeVisits ? obj : null;
  }
  for (const val of Object.values(obj)) {
    const found = findVisitsArray(val, depth + 1);
    if (found) return found;
  }
  return null;
}

// El título de la visita en SimpliRoute sigue el patrón "Nombre Cliente -
// numeroPedido" (visto en producción, ej: "Kevin Santos - 55453"). Si el
// payload no trae un campo de referencia explícito, lo sacamos del título.
function extractOrderNumber(payload) {
  const explicitRef = deepFind(payload, ['reference_id', 'reference', 'order_reference', 'order_number']);
  if (explicitRef) return String(explicitRef).replace(/^#/, '').trim();

  const title = deepFind(payload, ['title', 'visit_title', 'name']);
  if (title) {
    const match = String(title).match(/(\d{3,})\s*$/);
    if (match) return match[1];
  }
  return null;
}

function extractStatus(payload) {
  const status = deepFind(payload, ['status', 'checkout_status', 'visit_status', 'result']);
  return status ? String(status).toLowerCase() : null;
}

// Código para el link de seguimiento: el "ID de referencia" de la visita
// (que acá es el número de pedido). Si no viene, usamos el número que ya
// extrajimos del título.
export function buildTrackingCode(payload, orderNumber) {
  const ref = deepFind(payload, ['reference', 'reference_id']);
  const code = String(ref ?? orderNumber ?? '').replace(/^#/, '').trim();
  return code || null;
}

export function buildTrackingUrl(payload, orderNumber) {
  const code = buildTrackingCode(payload, orderNumber);
  return code ? `${TRACKING_URL_BASE}${encodeURIComponent(code)}` : null;
}

// Resuelve teléfono + nombre del cliente de un envío, en orden de preferencia:
//  1. el propio payload de SimpliRoute (contact_phone) — es el que la app de
//     reparto tiene cargado y usa para su tracking
//  2. TiendaNube, por número de pedido
//  3. Odoo, por número de pedido (findOdooOrder prueba TN<n> y S<n>) → partner
// Devuelve null si no aparece en ningún lado.
export async function resolveShipmentContact(payload, orderNumber, deps = {}) {
  const findOrder_ = deps.findOrder ?? findOrder;
  const findOdooOrder_ = deps.findOdooOrder ?? findOdooOrder;
  const getPartnerContact_ = deps.getPartnerContact ?? getPartnerContact;

  const fromPayload = deepFind(payload, ['contact_phone', 'phone']);
  if (fromPayload && String(fromPayload).trim()) {
    const phone = normalizePhone(fromPayload);
    if (phone) {
      return { phone, name: deepFind(payload, ['contact_name', 'name']) ?? null, source: 'simpliroute' };
    }
  }

  const tnOrder = await findOrder_(orderNumber).catch(() => null);
  const tnPhone = normalizePhone(tnOrder?.customer?.phone ?? '');
  if (tnPhone) {
    return { phone: tnPhone, name: tnOrder.customer?.name ?? null, source: 'tiendanube' };
  }

  const odoo = await findOdooOrder_(orderNumber).catch(() => null);
  const partnerId = Array.isArray(odoo?.order?.partner_id) ? odoo.order.partner_id[0] : null;
  if (partnerId) {
    const contact = await getPartnerContact_(partnerId).catch(() => null);
    const odPhone = normalizePhone(contact?.phone ?? '');
    if (odPhone) {
      const name = Array.isArray(odoo.order.partner_id) ? odoo.order.partner_id[1] : null;
      return { phone: odPhone, name: name ?? null, source: 'odoo' };
    }
  }

  return null;
}

async function getBotConfig() {
  try {
    const doc = await getDb().collection('bot-altorancho_config').doc('bot_config').get();
    return doc.exists ? doc.data() : {};
  } catch {
    return {};
  }
}

// Deja registro de cada intento de notificación (enviado, error u omitido)
// para el módulo de Historial — sin esto, un pedido que falla en silencio
// (sin teléfono, no encontrado en TiendaNube) no queda rastreable.
async function logSimpliRouteNotification(entry) {
  try {
    await getDb().collection(HISTORY_COLLECTION).add({ sentAt: new Date(), ...entry });
  } catch (err) {
    console.error('[simpliroute] Error guardando historial:', err.message);
  }
}

// Envía la plantilla correspondiente al cliente de un pedido. Reutilizado
// tanto por el checkout (un pedido) como por el inicio de ruta (N pedidos).
// `payload` es la visita (trae contact_phone, reference, etc.).
async function notifyOrder(orderNumber, templateName, event, payload = {}, botConfig = {}) {
  const trackingUrl = buildTrackingUrl(payload, orderNumber);
  const base = { event, templateName, orderNumber, trackingUrl: trackingUrl ?? null };

  const contact = await resolveShipmentContact(payload, orderNumber);
  if (!contact) {
    console.warn(`[simpliroute] Pedido #${orderNumber}: sin teléfono (ni payload, ni TiendaNube, ni Odoo) — no se notifica`);
    await logSimpliRouteNotification({ ...base, status: 'skipped', reason: 'Sin teléfono (payload/TiendaNube/Odoo)' });
    return;
  }
  const { phone, name: customerName, source } = contact;
  base.source = source;

  const bodyParams = [String(orderNumber)];
  // El botón de seguimiento sólo se manda si está prendido en Config Y las
  // plantillas de Meta ya tienen el botón URL "Ver seguimiento" aprobado.
  const trackingCode = buildTrackingCode(payload, orderNumber);
  const urlButtonParam = botConfig.simpliRouteTrackingButton && trackingCode ? trackingCode : null;

  // Mismo patrón que sendBulkOrders (notifications.service.js): dejar
  // rastro en la conversación del cliente antes de mandar por Meta, para
  // poder ver en el chat qué plantilla se le mandó si después se queja.
  const msgId = crypto.randomUUID();
  try {
    await getOrCreateConversation(phone, 'whatsapp', customerName);
    await appendMessage(phone, {
      role: 'admin',
      content: `[Plantilla: ${templateName}] pedido #${orderNumber}`,
      msgId,
      msgStatus: 'sending',
    });

    let waMsgId = null;
    let sendError = null;
    try {
      waMsgId = await sendWhatsAppTemplate(phone, templateName, 'es_AR', bodyParams, urlButtonParam);
    } catch (err) {
      sendError = err;
    }
    await updateMessageStatus(phone, msgId, sendError ? 'error' : 'sent', waMsgId).catch(() => {});
    if (sendError) throw sendError;

    await markNotified(phone);
    console.log(`[simpliroute] "${templateName}" enviado a ${phone} (${source}) por pedido #${orderNumber} — tracking: ${trackingUrl ?? '-'}`);
    await logSimpliRouteNotification({ ...base, status: 'sent', customerName, phone, waMsgId });
  } catch (err) {
    const reason = err.response?.data?.error?.message ?? err.message;
    console.error(`[simpliroute] Error notificando pedido #${orderNumber}:`, reason);
    await logSimpliRouteNotification({ ...base, status: 'error', customerName, phone, reason });
  }
}

// Evento "Checkout": una visita puntual fue completada (con éxito o no).
export async function handleSimpliRouteCheckout(payload) {
  console.log('[simpliroute] checkout payload recibido:', JSON.stringify(payload));

  const orderNumber = extractOrderNumber(payload);
  const statusRaw = extractStatus(payload);

  if (!orderNumber) {
    console.warn('[simpliroute] checkout: no se pudo extraer número de pedido — revisar shape real en logs de arriba');
    return;
  }

  const isSuccess = statusRaw && SUCCESS_VALUES.has(statusRaw);
  const isFailed = statusRaw && FAILED_VALUES.has(statusRaw);
  if (!isSuccess && !isFailed) {
    console.warn(`[simpliroute] checkout: estado "${statusRaw}" no reconocido para pedido #${orderNumber} — no se envía notificación`);
    return;
  }

  const botConfig = await getBotConfig();
  await notifyOrder(orderNumber, isSuccess ? TEMPLATE_DELIVERED : TEMPLATE_FAILED, 'checkout', payload, botConfig);
}

// Evento "Inicio de ruta": el conductor arrancó el reparto del día — trae
// (se asume) la lista completa de visitas de esa ruta. Se notifica a cada
// cliente que su pedido salió hoy en reparto.
export async function handleSimpliRouteRouteStart(payload) {
  console.log('[simpliroute] inicio de ruta payload recibido:', JSON.stringify(payload));

  const visits = findVisitsArray(payload) ?? [];
  if (visits.length === 0) {
    // Puede que el payload real no traiga la lista de visitas inline — si
    // pasa esto seguido, revisar el log de arriba y decidir si hay que
    // pedirle a SimpliRoute el detalle de la ruta por API en vez de esperarlo acá.
    console.warn('[simpliroute] inicio de ruta: no se encontró un array de visitas en el payload');
    return;
  }

  const botConfig = await getBotConfig();
  for (const visit of visits) {
    const orderNumber = extractOrderNumber(visit);
    if (!orderNumber) {
      console.warn('[simpliroute] inicio de ruta: visita sin número de pedido identificable:', JSON.stringify(visit));
      continue;
    }
    await notifyOrder(orderNumber, TEMPLATE_ON_ROUTE, 'route_start', visit, botConfig);
    await new Promise(r => setTimeout(r, 200)); // margen para no ráfagar la API de Meta
  }
}

// Últimos envíos disparados por SimpliRoute (enviados, con error, u
// omitidos), para el módulo de Historial.
export async function getSimpliRouteNotificationHistory(limit = 100) {
  const snap = await getDb().collection(HISTORY_COLLECTION).orderBy('sentAt', 'desc').limit(limit).get();
  return snap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    sentAt: d.data().sentAt?.toDate?.()?.toISOString() ?? d.data().sentAt,
  }));
}
