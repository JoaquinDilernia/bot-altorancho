import https from 'https';
import axios from 'axios';

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB  = process.env.ODOO_DB  ?? 'odoo';

let cachedUid = null;

async function getUid() {
  if (cachedUid) return cachedUid;
  const { data } = await axios.post(`${ODOO_URL}/jsonrpc`, {
    jsonrpc: '2.0', method: 'call',
    params: {
      service: 'common', method: 'authenticate',
      args: [ODOO_DB, process.env.ODOO_USER, process.env.ODOO_API_KEY, {}],
    },
  });
  if (!data.result) throw new Error('[odoo] Auth failed');
  cachedUid = data.result;
  return cachedUid;
}

async function callOdoo(model, method, args = [], kwargs = {}) {
  const uid = await getUid();
  const { data } = await axios.post(`${ODOO_URL}/jsonrpc`, {
    jsonrpc: '2.0', method: 'call',
    params: {
      service: 'object', method: 'execute_kw',
      args: [ODOO_DB, uid, process.env.ODOO_API_KEY, model, method, args, kwargs],
    },
  });
  if (data.error) {
    cachedUid = null; // reset uid on error
    throw new Error(data.error.data?.message ?? 'Odoo RPC error');
  }
  return data.result;
}

const ORDER_FIELDS = ['name', 'state', 'partner_id', 'amount_total', 'date_order',
                      'delivery_status', 'invoice_status', 'order_line', 'note', 'warehouse_id'];

// Warehouse ID del canal E-Commerce (pedidos web/TiendaNube)
const ECOMMERCE_WAREHOUSE_ID = 24;

// Las 3 tiendas físicas al público (en orden de display)
const KNOWN_STORES = ['Belgrano', 'Las Lomas', 'Alcorta'];

// Umbral para "Quedan pocos" (qty > 0 pero menor a esto)
const LOW_STOCK_THRESHOLD = 5;

// Prefijo de SKU para productos de solo exhibición
const DISPLAY_ONLY_PREFIX = 'M';

async function getOrderLines(lineIds) {
  if (!lineIds?.length) return [];
  try {
    return await callOdoo('sale.order.line', 'read', [lineIds],
      { fields: ['product_id', 'product_uom_qty', 'name'] });
  } catch {
    return [];
  }
}

/**
 * Busca un pedido por nombre/número en Odoo.
 * Soporta: "S08121", "TN1999675391", "08121", "1999675391"
 */
export async function findOdooOrder(query) {
  const q = String(query).trim();

  // Construir variantes del nombre a buscar
  const candidates = new Set([q.toUpperCase()]);
  if (/^\d+$/.test(q)) {
    candidates.add(`TN${q}`);  // TiendaNube: TN1999675391
    candidates.add(`S${q.padStart(5, '0')}`); // Odoo: S08121
    candidates.add(`S${q}`);
  }
  // Si empieza con TN o S, agregar versión sin prefijo para buscar en TN también
  if (/^TN\d+$/i.test(q)) candidates.add(q.replace(/^TN/i, ''));
  if (/^S\d+$/i.test(q)) candidates.add(q.replace(/^S/i, ''));

  const domain = [['name', 'in', [...candidates]]];

  try {
    const results = await callOdoo('sale.order', 'search_read',
      [domain], { fields: ORDER_FIELDS, limit: 5 });

    if (!results?.length) return null;

    // Preferir el que haga match exacto
    const exact = results.find(o => candidates.has(o.name.toUpperCase())) ?? results[0];
    const lines = await getOrderLines(exact.order_line);
    return { order: exact, lines };
  } catch (err) {
    console.error('[odoo] findOdooOrder error:', err.message);
    return null;
  }
}

/**
 * Busca pedidos de un cliente por teléfono o email.
 */
export async function findOdooOrdersByContact(contact) {
  const isEmail = contact.includes('@');
  const field = isEmail ? 'email' : 'phone';

  // Normalizar teléfono: quitar +, espacios
  const normalized = contact.replace(/[\s+\-()]/g, '');

  try {
    const partners = await callOdoo('res.partner', 'search_read',
      [[[field, 'ilike', isEmail ? contact : normalized]]],
      { fields: ['id', 'name'], limit: 5 });

    if (!partners?.length) return [];

    const partnerIds = partners.map(p => p.id);
    const orders = await callOdoo('sale.order', 'search_read',
      [[['partner_id', 'in', partnerIds], ['state', '!=', 'cancel']]],
      { fields: ORDER_FIELDS, limit: 5, order: 'date_order desc' });

    return orders ?? [];
  } catch (err) {
    console.error('[odoo] findOdooOrdersByContact error:', err.message);
    return [];
  }
}

const STOCK_PROXY = 'lett.exemax.ar';

/**
 * Consulta stock de un SKU contra el proxy de Odoo.
 * Usa https nativo porque GET con body no funciona con fetch.
 * @param {string} sku
 * @returns {Promise<Array<{warehouse:string, warehouse_id:number, qty:number}>>}
 */
export async function getStockBySku(sku) {
  return new Promise((resolve) => {
    const body = JSON.stringify({});
    const path = `/odoo-api/get-product/${encodeURIComponent(sku)}`;
    const req = https.request({
      hostname: STOCK_PROXY,
      path,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(Array.isArray(json.result) ? json.result : []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', err => {
      console.error('[odoo-stock] proxy error:', err.message);
      resolve([]);
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.write(body);
    req.end();
  });
}

/**
 * Formatea el resultado de stock para el system prompt de Claude.
 * Siempre muestra los 3 locales con etiquetas — nunca cantidades numéricas.
 *
 * Modo normal:
 *   qty >= LOW_STOCK_THRESHOLD → "Disponible"
 *   0 < qty < threshold        → "Quedan pocos"
 *   ausente en proxy / qty=0   → "No disponible"
 *
 * Modo exhibición (SKU empieza con DISPLAY_ONLY_PREFIX = "M"):
 *   presente en proxy           → "Exhibido"
 *   ausente                     → "No exhibido"
 *
 * @param {string} productName
 * @param {string} sku
 * @param {Array<{warehouse:string, qty:number}>} stockResult
 * @returns {string}
 */
export function formatStockInfo(productName, sku, stockResult) {
  const isDisplayOnly = sku.toUpperCase().startsWith(DISPLAY_ONLY_PREFIX);

  // Mapear proxy result a un dict por nombre de tienda (partial match, case-insensitive)
  const proxyMap = {};
  for (const w of (stockResult ?? [])) {
    const match = KNOWN_STORES.find(s => w.warehouse.toLowerCase().includes(s.toLowerCase()));
    if (match) proxyMap[match] = w.qty;
  }

  const lines = KNOWN_STORES.map(store => {
    const qty = proxyMap[store] ?? 0;
    if (isDisplayOnly) {
      return `- ${store}: ${qty > 0 ? 'Exhibido' : 'No exhibido'}`;
    }
    if (qty <= 0)                    return `- ${store}: No disponible`;
    if (qty < LOW_STOCK_THRESHOLD)   return `- ${store}: Quedan pocos`;
    return                                  `- ${store}: Disponible`;
  }).join('\n');

  if (isDisplayOnly) {
    return `Producto: ${productName} (SKU: ${sku}) — Producto de exhibición\nDisponibilidad para ver en local:\n${lines}`;
  }

  return `Producto: ${productName} (SKU: ${sku})\nDisponibilidad en sucursales:\n${lines}`;
}

/**
 * Busca pedidos de un cliente por nombre completo o parcial.
 */
export async function findOdooOrdersByName(name) {
  try {
    const partners = await callOdoo('res.partner', 'search_read',
      [[['name', 'ilike', name], ['customer_rank', '>', 0]]],
      { fields: ['id', 'name'], limit: 5 });

    if (!partners?.length) return [];

    const partnerIds = partners.map(p => p.id);
    const orders = await callOdoo('sale.order', 'search_read',
      [[['partner_id', 'in', partnerIds], ['state', '!=', 'cancel']]],
      { fields: ORDER_FIELDS, limit: 5, order: 'date_order desc' });

    return orders ?? [];
  } catch (err) {
    console.error('[odoo] findOdooOrdersByName error:', err.message);
    return [];
  }
}

/**
 * Formatea un pedido de Odoo en texto legible para el bot.
 */
export function formatOdooOrder(order, lines = []) {
  if (!order) return null;

  const stateMap = {
    draft:  'cotización/borrador',
    sent:   'enviada al cliente',
    sale:   'confirmado',
    done:   'completado',
    cancel: 'cancelado',
  };

  const deliveryMap = {
    pending: 'pendiente de envío',
    full:    'enviado completo',
    partial: 'enviado parcial',
  };

  const invoiceMap = {
    invoiced:   'facturado',
    to_invoice: 'pendiente de facturación',
    nothing:    '-',
  };

  const productos = lines
    .filter(l => l.product_id && l.product_uom_qty > 0)
    .map(l => {
      const name = typeof l.product_id === 'object' ? l.product_id[1] : l.name;
      return `${name} x${l.product_uom_qty}`;
    })
    .join(', ') || null;

  const warehouseId = Array.isArray(order.warehouse_id) ? order.warehouse_id[0] : null;
  const warehouseName = Array.isArray(order.warehouse_id) ? order.warehouse_id[1] : null;
  const isWeb = warehouseId === ECOMMERCE_WAREHOUSE_ID || /^TN\d+$/i.test(order.name);

  return {
    numero:   order.name,
    tipo:     isWeb ? 'WEB' : 'LOCAL',
    local:    isWeb ? null : (warehouseName ?? null),
    estado:   stateMap[order.state] ?? order.state,
    envio:    deliveryMap[order.delivery_status] ?? order.delivery_status ?? '-',
    pago:     invoiceMap[order.invoice_status] ?? order.invoice_status ?? '-',
    total:    order.amount_total,
    cliente:  Array.isArray(order.partner_id) ? order.partner_id[1] : 'Cliente',
    productos,
    fecha:    order.date_order
      ? new Date(order.date_order).toLocaleDateString('es-AR')
      : null,
    nota:     order.note ?? null,
  };
}
