// Datos del contacto que se pueden insertar en una plantilla creada desde
// Difusiones. El texto se escribe con tokens legibles ({{primer_nombre}}) y
// acá se traducen al formato numerado que exige Meta ({{1}}, {{2}}…).

function firstWord(name) {
  const w = (name ?? '').trim().split(/\s+/)[0];
  return w || null;
}

function formatMoney(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return null;
  return `$ ${String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

// tnLastOrderAt se guarda como 'YYYY-MM-DD' (customer.service.js).
function formatDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export const TEMPLATE_VARS = [
  { key: 'nombre', label: 'Nombre completo', sample: 'Juan Pérez', fallback: 'Cliente',
    resolve: (c) => c.contactName?.trim() || null },
  { key: 'primer_nombre', label: 'Primer nombre', sample: 'Juan', fallback: 'Cliente',
    resolve: (c) => firstWord(c.contactName) },
  { key: 'pedidos', label: 'Cantidad de pedidos', sample: '3', fallback: '0',
    resolve: (c) => (c.tnOrderCount === null || c.tnOrderCount === undefined ? null : String(c.tnOrderCount)) },
  { key: 'gastado', label: 'Total gastado', sample: '$ 45.000', fallback: '$ 0',
    resolve: (c) => formatMoney(c.tnTotalSpent) },
  { key: 'ultimo_pedido', label: 'Fecha del último pedido', sample: '12/09/2026', fallback: '-',
    resolve: (c) => formatDay(c.tnLastOrderAt) },
  { key: 'link', label: 'Link de la promo', sample: 'https://altorancho.com.ar', fallback: '-',
    resolve: (_c, ctx) => ctx?.link || null },
];

const VAR_MAP = Object.fromEntries(TEMPLATE_VARS.map(v => [v.key, v]));
const TOKEN_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/** Meta rechaza parámetros vacíos, con \n / \t o con 4+ espacios seguidos. */
export function sanitizeParam(value) {
  const clean = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return clean || '-';
}

export function toMetaBody(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw badRequest('El texto del mensaje es obligatorio');
  const order = [];
  const body = trimmed.replace(TOKEN_RE, (_m, raw) => {
    const key = raw.toLowerCase();
    if (!VAR_MAP[key]) throw badRequest(`Dato desconocido en el texto: {{${raw}}}`);
    let idx = order.indexOf(key);
    if (idx === -1) { order.push(key); idx = order.length - 1; }
    return `{{${idx + 1}}}`;
  });
  if (order.length > 0 && (/^\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}$/.test(body))) {
    throw badRequest('El texto no puede empezar ni terminar con un dato (Meta lo rechaza). Agregá un saludo antes o un punto al final.');
  }
  return { body, order };
}

export function resolveVars(order, contact, link) {
  return order.map((key) => {
    const v = VAR_MAP[key];
    const value = v.resolve(contact ?? {}, { link });
    const clean = value === null || value === undefined ? '' : sanitizeParam(value);
    return clean && clean !== '-' ? clean : v.fallback;
  });
}

export function sampleValues(order) {
  return order.map(key => VAR_MAP[key].sample);
}
