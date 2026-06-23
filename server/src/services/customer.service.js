import { getDb } from './firebase.service.js';
import { findCustomerByPhone, getCustomerOrders } from './tiendanube.service.js';

const COLLECTION = 'bot-altorancho_customers';
const TN_CACHE_HOURS = 24;

export async function getOrCreateCustomer(contactId, channel, contactName = null) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);
  const doc = await docRef.get();

  if (doc.exists) {
    const updates = { lastContactAt: new Date() };
    if (contactName && !doc.data().contactName) updates.contactName = contactName;
    await docRef.update(updates);
    return { id: doc.id, ...doc.data(), ...updates };
  }

  const customer = {
    contactId,
    channel,
    contactName: contactName ?? null,
    firstContactAt: new Date(),
    lastContactAt: new Date(),
    agentNotes: '',
    tags: [],
    tnCustomerId: null,
    tnEmail: null,
    tnOrders: [],
    tnOrdersUpdatedAt: null,
  };

  await docRef.set(customer);
  return { id: contactId, ...customer };
}

export async function getCustomerProfile(contactId) {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(contactId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function updateCustomerNotes(contactId, agentNotes) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({
    agentNotes: agentNotes ?? '',
    updatedAt: new Date(),
  });
}

export async function enrichCustomerFromTiendaNube(contactId, forceRefresh = false) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);
  const doc = await docRef.get();
  if (!doc.exists) return;

  const data = doc.data();

  if (!forceRefresh && data.tnOrdersUpdatedAt) {
    const updatedAt = data.tnOrdersUpdatedAt._seconds
      ? new Date(data.tnOrdersUpdatedAt._seconds * 1000)
      : new Date(data.tnOrdersUpdatedAt);
    const hoursSince = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSince < TN_CACHE_HOURS) return;
  }

  const phone = contactId.replace(/\D/g, '');
  const tnCustomer = await findCustomerByPhone(phone);

  if (!tnCustomer) {
    await docRef.update({ tnOrdersUpdatedAt: new Date() });
    return;
  }

  const rawOrders = await getCustomerOrders(tnCustomer.id);

  const tnOrders = (rawOrders ?? []).slice(0, 10).map(o => ({
    number: o.number,
    date: o.created_at?.split('T')[0] ?? null,
    status: o.status,
    paymentStatus: o.payment_status,
    shippingStatus: o.shipping_status,
    total: o.total,
    products: (o.products ?? []).map(p => {
      const name = typeof p.name === 'string' ? p.name
        : (p.name?.es ?? p.name?.en ?? Object.values(p.name ?? {})[0] ?? 'Producto');
      const variants = (p.variant_values ?? []).join(' / ');
      return variants ? `${name} (${variants})` : name;
    }),
  }));

  await docRef.update({
    tnCustomerId: tnCustomer.id,
    tnEmail: tnCustomer.email ?? null,
    contactName: data.contactName ?? tnCustomer.name ?? null,
    tnOrders,
    tnOrdersUpdatedAt: new Date(),
  });
}

export async function linkCustomerFromOrder(contactId, tnCustomer) {
  if (!tnCustomer?.id) return;
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);
  const doc = await docRef.get();
  if (!doc.exists) return;
  const data = doc.data();
  if (data.tnCustomerId) return;

  const rawOrders = await getCustomerOrders(tnCustomer.id);
  const tnOrders = (rawOrders ?? []).slice(0, 10).map(o => ({
    number: o.number,
    date: o.created_at?.split('T')[0] ?? null,
    status: o.status,
    paymentStatus: o.payment_status,
    shippingStatus: o.shipping_status,
    total: o.total,
    products: (o.products ?? []).map(p => {
      const name = typeof p.name === 'string' ? p.name
        : (p.name?.es ?? p.name?.en ?? Object.values(p.name ?? {})[0] ?? 'Producto');
      const variants = (p.variant_values ?? []).join(' / ');
      return variants ? `${name} (${variants})` : name;
    }),
  }));

  await docRef.update({
    tnCustomerId: tnCustomer.id,
    tnEmail: tnCustomer.email ?? null,
    contactName: data.contactName ?? tnCustomer.name ?? null,
    tnOrders,
    tnOrdersUpdatedAt: new Date(),
  });
  console.log(`[customer] Auto-linked ${contactId} → TN customer #${tnCustomer.id}`);
}

export function buildCustomerContext(customer) {
  if (!customer) return null;

  const lines = [];
  if (customer.contactName) lines.push(`Nombre: ${customer.contactName}`);
  if (customer.tnEmail) lines.push(`Email: ${customer.tnEmail}`);
  lines.push(`Canal: ${customer.channel}`);
  if (customer.firstContactAt) lines.push(`Primera consulta: ${formatDate(customer.firstContactAt)}`);

  if (customer.tnOrders?.length) {
    lines.push(`\nHistorial de compras en Tienda Nube (${customer.tnOrders.length} pedido/s):`);
    for (const o of customer.tnOrders) {
      const parts = [`#${o.number}`, o.date ?? '?', `$${o.total}`];
      if (o.status) parts.push(`estado: ${o.status}`);
      if (o.paymentStatus) parts.push(`pago: ${o.paymentStatus}`);
      if (o.shippingStatus) parts.push(`envío: ${o.shippingStatus}`);
      if (o.products?.length) parts.push(`productos: ${o.products.join(', ')}`);
      lines.push(`  - ${parts.join(' | ')}`);
    }
  } else {
    lines.push('Sin compras registradas en Tienda Nube.');
  }

  if (customer.agentNotes) {
    lines.push(`\nNotas del equipo: ${customer.agentNotes}`);
  }

  return lines.join('\n');
}

function formatDate(ts) {
  if (!ts) return '';
  try {
    const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
    return d.toLocaleDateString('es-AR');
  } catch { return ''; }
}
