import axios from 'axios';

const BASE_URL = 'https://api.tiendanube.com/v1';

const client = axios.create({
  baseURL: `${BASE_URL}/${process.env.TIENDANUBE_STORE_ID}`,
  headers: {
    Authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
    'User-Agent': 'BOT-ALTORANCHO/1.0',
    'Content-Type': 'application/json',
  },
});

const ORDER_FIELDS = 'id,number,status,payment_status,shipping_status,customer,products,total,shipping_tracking_url,shipping_option,note,created_at';

const TN_PAGE_SIZE = 200; // máximo que permite TiendaNube

/**
 * Busca un pedido por número exacto (ej: 51689) o email.
 *
 * Estrategia dual:
 * Fase 1 — q= en paralelo por los 3 estados: cubre pedidos recientes indexados.
 *           TiendaNube indexa para q= con cierto delay y solo hasta N pedidos atrás.
 * Fase 2 — Paginación directa: si fase 1 falla, calibra con el pedido más reciente
 *           y busca por página estimada ± 2 para encontrar pedidos más viejos.
 *
 * @param {string} query - Número de pedido o email
 * @returns {Promise<object|null>}
 */
export async function findOrder(query) {
  const num = String(query.trim());

  if (num.includes('@')) {
    try {
      const { data } = await client.get('/orders', {
        params: { q: num, fields: ORDER_FIELDS, per_page: 5 },
      });
      return data?.[0] ?? null;
    } catch (err) {
      console.error('[tiendanube] Error buscando por email:', err.message);
      return null;
    }
  }

  // --- Fase 1: búsqueda por q= (rápida, cubre pedidos recientes) ---
  try {
    const [r1, r2, r3] = await Promise.all([
      client.get('/orders', { params: { q: num, fields: ORDER_FIELDS, per_page: 50 } }),
      client.get('/orders', { params: { q: num, fields: ORDER_FIELDS, per_page: 50, status: 'closed' } }),
      client.get('/orders', { params: { q: num, fields: ORDER_FIELDS, per_page: 50, status: 'cancelled' } }),
    ]);

    const seen = new Set();
    const allOrders = [...(r1.data ?? []), ...(r2.data ?? []), ...(r3.data ?? [])]
      .filter(o => !seen.has(o.id) && seen.add(o.id));

    const qMatch = allOrders.find(o => String(o.number) === num)
      ?? allOrders.find(o => String(o.id) === num)
      ?? null;

    if (qMatch) {
      console.log(`[tiendanube] findOrder #${num}: encontrado via q= (id:${qMatch.id}, status:${qMatch.status})`);
      return qMatch;
    }
  } catch { /* continuar a fase 2 */ }

  // --- Fase 2: paginación directa para pedidos más viejos ---
  const targetNum = parseInt(num, 10);
  if (isNaN(targetNum)) return null;

  try {
    // Calibrar con el pedido más reciente para estimar la página
    const { data: calibData } = await client.get('/orders', {
      params: { per_page: 1, fields: 'number' },
    });
    const latestNum = calibData?.[0]?.number;

    if (!latestNum || targetNum > latestNum) {
      console.log(`[tiendanube] findOrder #${num}: número no existe (último: #${latestNum})`);
      return null;
    }

    if (targetNum === latestNum) {
      // Era el primer pedido, calibración ya lo trajo
      const { data: exact } = await client.get('/orders', { params: { per_page: 1, fields: ORDER_FIELDS } });
      return exact?.[0] ?? null;
    }

    // Estimación: pedidos ordenados de más nuevo a más viejo en páginas de TN_PAGE_SIZE
    // Página 1 = los TN_PAGE_SIZE más recientes, página 2 = los siguientes, etc.
    const diff = latestNum - targetNum;
    const estimatedPage = Math.max(1, Math.ceil(diff / TN_PAGE_SIZE));

    // Buscar en página estimada ± 2 en paralelo (incluyendo página 1 para pedidos recientes)
    const pages = [estimatedPage - 1, estimatedPage, estimatedPage + 1, estimatedPage + 2]
      .filter(p => p >= 1);

    console.log(`[tiendanube] findOrder #${num}: q= sin resultados, buscando via paginación (último:#${latestNum}, diff:${diff}, páginas:${pages.join(',')})`);

    const pageResults = await Promise.all(
      pages.map(p =>
        client.get('/orders', { params: { page: p, per_page: TN_PAGE_SIZE, fields: ORDER_FIELDS } })
          .then(r => r.data ?? [])
          .catch(() => [])
      )
    );

    const pageSeen = new Set();
    const pageOrders = pageResults.flat()
      .filter(o => !pageSeen.has(o.id) && pageSeen.add(o.id));

    const pageMatch = pageOrders.find(o => o.number === targetNum) ?? null;

    if (pageMatch) {
      console.log(`[tiendanube] findOrder #${num}: encontrado via paginación (id:${pageMatch.id}, status:${pageMatch.status})`);
    } else if (pageOrders.length) {
      const nums = pageOrders.map(o => o.number);
      console.log(`[tiendanube] findOrder #${num}: no encontrado. Rango paginado: #${Math.min(...nums)}-#${Math.max(...nums)}`);
    } else {
      console.log(`[tiendanube] findOrder #${num}: paginación devolvió vacío`);
    }

    return pageMatch;
  } catch (err) {
    console.error('[tiendanube] findOrder fase2 error:', err.message, err.response?.status);
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
        customer_ids: customerId,
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
