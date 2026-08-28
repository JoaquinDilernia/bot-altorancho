import crypto from 'crypto';
import { getDb } from './firebase.service.js';
import { sendWhatsAppTemplate } from './meta.service.js';
import { findOrder } from './tiendanube.service.js';
import { getOrCreateConversation, appendMessage, updateMessageStatus, markNotified } from './conversation.service.js';
import { normalizePhone } from './notifications.service.js';

const HISTORY_COLLECTION = 'bot-altorancho_simpliroute_notifications';

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
async function notifyOrder(orderNumber, templateName, event) {
  const base = { event, templateName, orderNumber };

  const order = await findOrder(orderNumber);
  if (!order) {
    console.warn(`[simpliroute] Pedido #${orderNumber} no encontrado en TiendaNube — no se puede notificar`);
    await logSimpliRouteNotification({ ...base, status: 'skipped', reason: 'Pedido no encontrado en TiendaNube' });
    return;
  }

  const phone = normalizePhone(order.customer?.phone ?? '');
  const customerName = order.customer?.name ?? null;
  if (!phone) {
    console.warn(`[simpliroute] Pedido #${orderNumber} sin teléfono de cliente — no se puede notificar`);
    await logSimpliRouteNotification({ ...base, status: 'skipped', reason: 'Sin teléfono', customerName });
    return;
  }

  const bodyParams = [String(order.number)];

  // Mismo patrón que sendBulkOrders (notifications.service.js): dejar
  // rastro en la conversación del cliente antes de mandar por Meta, para
  // poder ver en el chat qué plantilla se le mandó si después se queja.
  const msgId = crypto.randomUUID();
  try {
    await getOrCreateConversation(phone, 'whatsapp', customerName);
    await appendMessage(phone, {
      role: 'admin',
      content: `[Plantilla: ${templateName}] pedido #${order.number}`,
      msgId,
      msgStatus: 'sending',
    });

    let waMsgId = null;
    let sendError = null;
    try {
      waMsgId = await sendWhatsAppTemplate(phone, templateName, 'es_AR', bodyParams);
    } catch (err) {
      sendError = err;
    }
    await updateMessageStatus(phone, msgId, sendError ? 'error' : 'sent', waMsgId).catch(() => {});
    if (sendError) throw sendError;

    await markNotified(phone);
    console.log(`[simpliroute] "${templateName}" enviado a ${phone} por pedido #${order.number}`);
    await logSimpliRouteNotification({ ...base, status: 'sent', customerName, phone, waMsgId });
  } catch (err) {
    const reason = err.response?.data?.error?.message ?? err.message;
    console.error(`[simpliroute] Error notificando pedido #${order.number}:`, reason);
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

  await notifyOrder(orderNumber, isSuccess ? TEMPLATE_DELIVERED : TEMPLATE_FAILED, 'checkout');
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

  for (const visit of visits) {
    const orderNumber = extractOrderNumber(visit);
    if (!orderNumber) {
      console.warn('[simpliroute] inicio de ruta: visita sin número de pedido identificable:', JSON.stringify(visit));
      continue;
    }
    await notifyOrder(orderNumber, TEMPLATE_ON_ROUTE, 'route_start');
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
