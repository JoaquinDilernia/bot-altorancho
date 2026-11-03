// Atribución de ventas de difusiones (lógica pura, sin Firestore ni Meta).
//
// - addUtm: marca el link destino para que Tienda Nube / Analytics muestren
//   las ventas que entraron por la difusión (total de campaña).
// - attributeOrders: cruza destinatarios con sus pedidos de Tienda Nube por
//   teléfono (compra pagada dentro de N días desde el envío). Es atribución
//   por coincidencia: "compró después de recibirla", no "compró por ella";
//   por eso se separa a los que tocaron el link (señal fuerte).

export const ATTRIBUTION_WINDOW_DAYS = 7;

export function slugCampaign(name) {
  return (name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'difusion';
}

/** Si la URL ya trae algún utm_* se respeta tal cual (UTMs armados a mano). */
export function addUtm(url, { campaignSlug, content = null }) {
  if (!url) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  if ([...u.searchParams.keys()].some(k => k.toLowerCase().startsWith('utm_'))) return url;
  u.searchParams.set('utm_source', 'whatsapp');
  u.searchParams.set('utm_medium', 'difusion');
  u.searchParams.set('utm_campaign', campaignSlug);
  if (content) u.searchParams.set('utm_content', content);
  return u.toString();
}

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v._seconds) return new Date(v._seconds * 1000);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

// Los pedidos de TN se guardan como 'YYYY-MM-DD' tomado del created_at ISO,
// así que el día del envío se compara en el mismo formato (UTC).
function dayString(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayString(d);
}

function isCountable(o) {
  return o?.date && o.status !== 'cancelled' && o.paymentStatus === 'paid';
}

/** Hora exacta del pedido: la guardada en la ficha o, para fichas viejas, la que vino de TN. */
function orderTime(o, orderTimes) {
  return toDate(o.createdAt ?? orderTimes?.get(String(o.number)) ?? null);
}

/**
 * @param {object} p
 * @param {Array}  p.sends          filas de SENDS ({ contactId, contactName, status, sentAt, clickedAt })
 * @param {Map}    p.customersById  contactId canónico → cliente con tnOrders
 * @param {number} [p.windowDays]
 * @param {Map}    [p.orderTimes]   número de pedido → created_at de TN, para
 *                                  fichas guardadas antes de tener createdAt
 *
 * Con la hora exacta del pedido solo cuenta lo comprado DESPUÉS de recibir el
 * mensaje (en un Cyber se compra desde las 00:00 y el día solo no alcanza).
 * Sin hora, cae en la comparación por día.
 */
export function attributeOrders({ sends, customersById, windowDays = ATTRIBUTION_WINDOW_DAYS, orderTimes = null }) {
  const buyers = [];
  let recipients = 0;
  for (const s of sends ?? []) {
    const sentAt = toDate(s.sentAt);
    if (s.status === 'error' || !sentAt) continue;
    recipients++;
    const from = dayString(sentAt);
    const to = addDays(from, windowDays);
    const until = new Date(sentAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const orders = (customersById.get(s.contactId)?.tnOrders ?? [])
      .filter(o => {
        if (!isCountable(o)) return false;
        const at = orderTime(o, orderTimes);
        if (at) return at >= sentAt && at <= until;
        return o.date >= from && o.date <= to;
      })
      .sort((a, b) => (orderTime(a, orderTimes) ?? new Date(a.date)) - (orderTime(b, orderTimes) ?? new Date(b.date)));
    const first = orders[0];
    if (!first) continue;
    buyers.push({
      contactId: s.contactId,
      contactName: s.contactName ?? null,
      orderNumber: first.number ?? null,
      orderDate: first.date,
      total: Number(first.total) || 0,
      clicked: !!s.clickedAt,
    });
  }
  return {
    buyers,
    summary: {
      recipients,
      buyers: buyers.length,
      clickedBuyers: buyers.filter(b => b.clicked).length,
      revenue: buyers.reduce((sum, b) => sum + b.total, 0),
    },
  };
}
