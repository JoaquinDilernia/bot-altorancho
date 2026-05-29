import axios from 'axios';

const BASE_URL = 'https://api.tiendanube.com/v1';

const client = axios.create({
  baseURL: `${BASE_URL}/${process.env.TIENDANUBE_STORE_ID}`,
  headers: {
    Authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
    'User-Agent': 'BOT-GINEZA/1.0',
    'Content-Type': 'application/json',
  },
});

/**
 * Busca un pedido por número exacto o por email del cliente.
 * @param {string} query - Número de pedido o email
 * @returns {Promise<object|null>}
 */
export async function findOrder(query) {
  try {
    const fields = 'id,number,status,payment_status,shipping_status,customer,products,total,shipping_tracking_url,shipping_option,note,created_at';
    const isEmail = query.includes('@');
    const params = isEmail
      ? { q: query, fields }
      : { number: query.trim(), fields };

    console.log('[tiendanube] findOrder params:', params);
    const { data } = await client.get('/orders', { params });
    console.log('[tiendanube] findOrder results:', data?.length ?? 0, 'orders found');
    if (data?.length) console.log('[tiendanube] first match number:', data[0].number);
    return data?.[0] ?? null;
  } catch (err) {
    console.error('[tiendanube] Error buscando pedido:', err.message, err.response?.status, err.response?.data);
    return null;
  }
}

/**
 * Busca todos los pedidos de un cliente por email.
 * @param {string} email
 * @returns {Promise<Array>}
 */
export async function findOrdersByEmail(email) {
  try {
    const fields = 'id,number,status,payment_status,shipping_status,customer,products,total,created_at';
    const { data } = await client.get('/orders', { params: { q: email, fields, per_page: 5, sort_by: 'created_at', sort_direction: 'desc' } });
    return data ?? [];
  } catch (err) {
    console.error('[tiendanube] Error buscando pedidos por email:', err.message);
    return [];
  }
}

/**
 * Obtiene detalles de un pedido por ID interno.
 * @param {string|number} orderId
 * @returns {Promise<object|null>}
 */
export async function getOrderById(orderId) {
  try {
    const { data } = await client.get(`/orders/${orderId}`);
    return data;
  } catch (err) {
    console.error('[tiendanube] Error obteniendo pedido:', err.message);
    return null;
  }
}

/**
 * Busca productos por nombre o categoría.
 * @param {string} query
 * @returns {Promise<Array>}
 */
export async function searchProducts(query) {
  try {
    const { data } = await client.get('/products', {
      params: { q: query, published: true, fields: 'id,name,price,stock,images,variants' },
    });
    return data ?? [];
  } catch (err) {
    console.error('[tiendanube] Error buscando productos:', err.message);
    return [];
  }
}

/**
 * Busca un cliente por teléfono en Tienda Nube.
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
export async function findCustomerByPhone(phone) {
  try {
    const { data } = await client.get('/customers', {
      params: { q: phone, fields: 'id,name,email,phone' },
    });
    return data?.[0] ?? null;
  } catch (err) {
    console.error('[tiendanube] Error buscando cliente por teléfono:', err.message);
    return null;
  }
}

/**
 * Obtiene los últimos pedidos de un cliente por su ID de TN.
 * @param {number} customerId
 * @returns {Promise<Array>}
 */
export async function getCustomerOrders(customerId) {
  try {
    const { data } = await client.get('/orders', {
      params: {
        customer_id: customerId,
        fields: 'id,number,status,payment_status,shipping_status,created_at,total,products',
        sort_by: 'created_at',
        sort_direction: 'desc',
        per_page: 10,
      },
    });
    return data ?? [];
  } catch (err) {
    console.error('[tiendanube] Error obteniendo pedidos del cliente:', err.message);
    return [];
  }
}

/**
 * Obtiene info general de la tienda.
 * @returns {Promise<object|null>}
 */
export async function getStoreInfo() {
  try {
    const { data } = await client.get('/store');
    return data;
  } catch (err) {
    console.error('[tiendanube] Error obteniendo info tienda:', err.message);
    return null;
  }
}

/**
 * Formatea el estado de un pedido en texto legible.
 * @param {object} order
 * @returns {string}
 */
export function formatOrderStatus(order) {
  if (!order) return null;

  const statusMap = {
    open: 'abierto',
    closed: 'completado',
    cancelled: 'cancelado',
  };

  const paymentMap = {
    pending: 'pendiente de pago',
    authorized: 'autorizado',
    paid: 'pagado',
    voided: 'anulado',
    refunded: 'reembolsado',
    abandoned: 'abandonado',
  };

  const shippingMap = {
    unpacked: 'pendiente de preparación',
    fulfilling: 'en preparación',
    shipped: 'enviado',
    delivered: 'entregado',
    undelivered: 'no entregado',
    returned: 'devuelto',
  };

  return {
    numero: order.number,
    estado: statusMap[order.status] ?? order.status,
    pago: paymentMap[order.payment_status] ?? order.payment_status,
    envio: shippingMap[order.shipping_status] ?? order.shipping_status,
    tracking: order.shipping_tracking_url ?? null,
    total: order.total,
    cliente: order.customer?.name ?? 'Cliente',
    productos: (order.products ?? []).map(p => {
      const name = typeof p.name === 'string' ? p.name
        : (p.name?.es ?? p.name?.en ?? Object.values(p.name ?? {})[0] ?? 'Producto');
      const variants = (p.variant_values ?? []).join(' / ');
      const label = variants ? `${name} (${variants})` : name;
      return `${label} x${p.quantity ?? 1}`;
    }).join(', ') || null,
    fecha: order.created_at ? new Date(order.created_at).toLocaleDateString('es-AR') : null,
    metodoEnvio: order.shipping_option?.name ?? null,
    nota: order.note ?? null,
  };
}
