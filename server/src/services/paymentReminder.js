// Lógica pura del recordatorio de pago por transferencia (sin Firestore ni
// APIs), para poder testearla. El envío vive en paymentReminder.service.js.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// Argentina no tiene horario de verano: UTC-3 fijo. Railway corre en UTC.
const AR_OFFSET_MS = -3 * HOUR_MS;
// Si un recordatorio se pasó de su hora más que esto (backend caído, deploy
// largo), no se manda tarde — un "acordate de pagar" 15hs después confunde.
const LATE_LIMIT_MS = 12 * HOUR_MS;

export const DEFAULT_FIRST_DELAY_MINUTES = 30;
export const DEFAULT_SECOND_HOUR = 9;

// Transferencias de Pago Nube: payment_details.method === 'wire_transfer'
// (visto en pedidos reales). Cuando vence el CVU, Pago Nube pasa el pago a
// 'voided', así que con exigir 'pending' alcanza para no insistir de más.
export function isPendingTransfer(order) {
  return !!order
    && order.status === 'open'
    && order.payment_status === 'pending'
    && order.payment_details?.method === 'wire_transfer';
}

// Timestamp (ms) del día siguiente a la compra, a `hour` hora Argentina.
export function secondReminderAt(createdAt, hour) {
  const arNow = new Date(new Date(createdAt).getTime() + AR_OFFSET_MS);
  const arNextDayAtHourAsUtc = Date.UTC(arNow.getUTCFullYear(), arNow.getUTCMonth(), arNow.getUTCDate() + 1, hour);
  return arNextDayAtHourAsUtc - AR_OFFSET_MS;
}

// Qué pasos ('first' / 'second') tocan ahora para este pedido. Cada paso se
// intenta una sola vez: `record.first`/`record.second` existen apenas se
// intentó (enviado, error u omitido).
export function dueReminders(order, record, now, cfg) {
  if (!isPendingTransfer(order)) return [];
  const createdMs = new Date(order.created_at).getTime();
  const due = [];

  const firstAt = createdMs + (cfg.firstDelayMinutes ?? DEFAULT_FIRST_DELAY_MINUTES) * MINUTE_MS;
  if (cfg.firstTemplate && !record?.first && now >= firstAt && now - firstAt < LATE_LIMIT_MS) {
    due.push('first');
  }

  const secondAt = secondReminderAt(order.created_at, cfg.secondHour ?? DEFAULT_SECOND_HOUR);
  if (cfg.secondTemplate && !record?.second && now >= secondAt && now - secondAt < LATE_LIMIT_MS) {
    due.push('second');
  }

  return due;
}

function formatArs(total) {
  const n = Number(total);
  if (!Number.isFinite(n)) return String(total ?? '');
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Si no se pudo leer el CVU, la variable igual tiene que llevar algo (Meta
// rechaza parámetros vacíos) — se manda a la página de la compra.
export const CVU_FALLBACK = 'lo ves tocando "Ver datos de pago"';

export function needsCvu(paramTemplate) {
  return (paramTemplate ?? []).some(t => String(t).includes('{{cvu}}'));
}

// Variables de la plantilla configuradas en el panel: {{name}},
// {{firstname}}, {{number}}, {{total}}, {{cvu}} o texto fijo.
export function fillReminderParams(paramTemplate, order, cvu = null) {
  const name = order.customer?.name?.trim() || 'Cliente';
  return (paramTemplate ?? []).map(t =>
    String(t)
      .replaceAll('{{name}}', name)
      .replaceAll('{{firstname}}', name.split(/\s+/)[0])
      .replaceAll('{{number}}', String(order.number))
      .replaceAll('{{total}}', formatArs(order.total))
      .replaceAll('{{cvu}}', cvu || CVU_FALLBACK)
  );
}

// Página de confirmación de la compra (la misma que ve el cliente al
// terminar el checkout): muestra el CVU exclusivo de Pago Nube, el
// beneficiario y el monto. La API de TiendaNube no expone el CVU — sólo
// está ahí. El token viene en el pedido.
const STORE_URL = 'https://altorancho.com';

export function orderPageUrl(order) {
  if (!order?.id || !order?.token) return null;
  return `${STORE_URL}/checkout/v3/success/${order.id}/${order.token}`;
}

// El HTML viene con el markup escapado dentro de un JSON (<...), así
// que se busca el primer número de 22 dígitos después del rótulo.
export function extractCvu(html) {
  const match = String(html ?? '').match(/CVU exclusivo para esta compra[\s\S]{0,500}?\b(\d{22})\b/);
  return match ? match[1] : null;
}
