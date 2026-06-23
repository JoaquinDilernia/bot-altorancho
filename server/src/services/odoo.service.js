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
                      'delivery_status', 'invoice_status', 'order_line', 'note'];

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

  return {
    numero:  order.name,
    estado:  stateMap[order.state] ?? order.state,
    envio:   deliveryMap[order.delivery_status] ?? order.delivery_status ?? '-',
    pago:    invoiceMap[order.invoice_status] ?? order.invoice_status ?? '-',
    total:   order.amount_total,
    cliente: Array.isArray(order.partner_id) ? order.partner_id[1] : 'Cliente',
    productos,
    fecha:   order.date_order
      ? new Date(order.date_order).toLocaleDateString('es-AR')
      : null,
    nota:    order.note ?? null,
  };
}
