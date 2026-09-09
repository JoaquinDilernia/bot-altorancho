import { getDb } from './firebase.service.js';
import { findCustomerByPhone, getCustomerOrders, fetchAllCustomersWithOrders } from './tiendanube.service.js';

const COLLECTION = 'bot-altorancho_customers';
const TN_CACHE_HOURS = 24;

// Normaliza un número argentino a E.164 sin '+' (mismo criterio que
// conversation.routes.js:normalizeArgPhone). Local acá para no importar un
// archivo de rutas dentro de un servicio.
export function normalizePhone(raw) {
  let d = String(raw ?? '').trim().replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('54')) return d;
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('9') && d.length === 11) return `54${d}`;
  if (d.length === 10) return `549${d}`;
  return `54${d}`;
}

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
    email: null,
    firstContactAt: new Date(),
    lastContactAt: new Date(),
    agentNotes: '',
    tags: [],
    tnCustomerId: null,
    tnEmail: null,
    tnOrders: [],
    tnOrdersUpdatedAt: null,
    source: 'bot',
    createdAt: new Date(),
    updatedAt: new Date(),
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

// ─────────────────────────── Contactos (listado + CRUD) ───────────────────
// Mismo criterio que `searchConversations` en conversation.service.js: se
// trae la colección entera y se filtra en memoria — no hay tantos contactos
// como para justificar índices compuestos de Firestore, y así el filtro de
// texto + tags + canal + compras se resuelve con una sola función sin
// duplicar lógica entre server y client.

function norm(s) {
  return (s ?? '').toString().toLowerCase().normalize('NFD').replace(/[^\x20-\x7e]/g, '');
}

// Convierte 'YYYY-MM-DD' (o Date/timestamp) a ms; los pedidos de TN guardan la
// fecha como string plano.
function orderDateMs(date) {
  if (!date) return 0;
  const d = new Date(date);
  return isNaN(d) ? 0 : d.getTime();
}

function monthsAgoMs(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

/** Agregados de compras de Tienda Nube que se usan para segmentar. */
function tnAggregates(tnOrders = []) {
  let totalSpent = 0;
  let lastMs = 0;
  for (const o of tnOrders) {
    totalSpent += Number(o.total) || 0;
    const ms = orderDateMs(o.date);
    if (ms > lastMs) lastMs = ms;
  }
  return {
    tnOrderCount: tnOrders.length,
    tnTotalSpent: totalSpent,
    tnLastOrderAt: lastMs ? new Date(lastMs).toISOString().slice(0, 10) : null,
  };
}

function mapCustomerDoc(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    contactId: data.contactId ?? doc.id,
    channel: data.channel ?? null,
    contactName: data.contactName ?? null,
    email: data.email ?? data.tnEmail ?? null,
    tags: data.tags ?? [],
    agentNotes: data.agentNotes ?? '',
    source: data.source ?? 'bot',
    firstContactAt: data.firstContactAt ?? null,
    lastContactAt: data.lastContactAt ?? null,
    createdAt: data.createdAt ?? data.firstContactAt ?? null,
    updatedAt: data.updatedAt ?? null,
    tnOrders: data.tnOrders ?? [],
    ...tnAggregates(data.tnOrders ?? []),
  };
}

/**
 * @param {object} filters
 * @param {string}   [filters.q]                nombre / teléfono / email
 * @param {string[]} [filters.tags]             al menos una de estas tags
 * @param {string}   [filters.channel]          'whatsapp' | 'instagram'
 * @param {boolean}  [filters.hasOrders]        con al menos una compra en TN
 * @param {number}   [filters.spentMin]         gastó >= X en los últimos `spentMonths` meses
 * @param {number}   [filters.spentMonths=12]
 * @param {string}   [filters.product]          compró un producto que contiene este texto…
 * @param {number}   [filters.productMonths=12] …en los últimos N meses
 * @param {number}   [filters.orderCountMin]    tiene >= X pedidos (histórico)
 * @param {number}   [filters.lastOrderMaxDays] última compra hace <= N días (activos)
 * @param {number}   [filters.lastOrderMinDays] última compra hace >= N días (recompra)
 */
export async function listCustomers(filters = {}) {
  const db = getDb();
  const snap = await db.collection(COLLECTION).get();
  let docs = snap.docs.map(mapCustomerDoc);

  const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));

  if (filters.channel) docs = docs.filter(c => c.channel === filters.channel);
  if (filters.tags?.length) docs = docs.filter(c => filters.tags.some(t => c.tags.includes(t)));
  if (filters.hasOrders) docs = docs.filter(c => c.tnOrderCount > 0);

  const spentMin = num(filters.spentMin);
  if (spentMin != null) {
    const cutoff = monthsAgoMs(num(filters.spentMonths) ?? 12);
    docs = docs.filter(c => (c.tnOrders ?? [])
      .filter(o => orderDateMs(o.date) >= cutoff)
      .reduce((sum, o) => sum + (Number(o.total) || 0), 0) >= spentMin);
  }

  const product = norm(filters.product).trim();
  if (product) {
    const cutoff = monthsAgoMs(num(filters.productMonths) ?? 12);
    docs = docs.filter(c => (c.tnOrders ?? []).some(o =>
      orderDateMs(o.date) >= cutoff && (o.products ?? []).some(p => norm(p).includes(product))
    ));
  }

  const orderCountMin = num(filters.orderCountMin);
  if (orderCountMin != null) docs = docs.filter(c => c.tnOrderCount >= orderCountMin);

  const lastMax = num(filters.lastOrderMaxDays);
  const lastMin = num(filters.lastOrderMinDays);
  if (lastMax != null || lastMin != null) {
    docs = docs.filter(c => {
      if (!c.tnLastOrderAt) return false;
      const days = (Date.now() - orderDateMs(c.tnLastOrderAt)) / 86400000;
      if (lastMax != null && days > lastMax) return false;
      if (lastMin != null && days < lastMin) return false;
      return true;
    });
  }

  const q = norm(filters.q).trim();
  if (q) {
    docs = docs.filter(c => norm(c.contactName).includes(q) || norm(c.contactId).includes(q) || norm(c.email).includes(q));
  }

  docs.sort((a, b) => tsToMs(b.lastContactAt ?? b.createdAt) - tsToMs(a.lastContactAt ?? a.createdAt));
  return docs.map(({ tnOrders, ...rest }) => rest);
}

export async function listAllTags() {
  const db = getDb();
  const snap = await db.collection(COLLECTION).get();
  const set = new Set();
  snap.docs.forEach(doc => (doc.data().tags ?? []).forEach(t => set.add(t)));
  return [...set].sort((a, b) => norm(a).localeCompare(norm(b)));
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (ts._seconds) return ts._seconds * 1000;
  const d = new Date(ts);
  return isNaN(d) ? 0 : d.getTime();
}

/** Alta manual desde el panel — `contactId` ya viene normalizado (mismo
    formato que usa `/api/conversations/start` para WhatsApp). */
export async function createCustomer({ contactId, channel, contactName, email, tags }) {
  if (!contactId || !channel) {
    const e = new Error('contactId y channel son requeridos');
    e.status = 400;
    throw e;
  }
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);
  const existing = await docRef.get();
  if (existing.exists) {
    const e = new Error('Ya existe un contacto con ese identificador/teléfono');
    e.status = 409;
    throw e;
  }
  const customer = {
    contactId,
    channel,
    contactName: contactName?.trim() || null,
    email: email?.trim() || null,
    firstContactAt: null, // sin conversación todavía
    lastContactAt: null,
    agentNotes: '',
    tags: Array.isArray(tags) ? tags : [],
    tnCustomerId: null,
    tnEmail: null,
    tnOrders: [],
    tnOrdersUpdatedAt: null,
    source: 'manual',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await docRef.set(customer);
  return { id: contactId, ...customer };
}

export async function updateCustomer(contactId, patch) {
  const db = getDb();
  const update = { updatedAt: new Date() };
  if (patch.contactName !== undefined) update.contactName = patch.contactName?.trim() || null;
  if (patch.email !== undefined) update.email = patch.email?.trim() || null;
  if (patch.tags !== undefined) update.tags = Array.isArray(patch.tags) ? patch.tags : [];
  if (patch.agentNotes !== undefined) update.agentNotes = patch.agentNotes ?? '';
  await db.collection(COLLECTION).doc(contactId).update(update);
  return getCustomerProfile(contactId);
}

export async function deleteCustomer(contactId) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).delete();
}

// ─────────────────────────── Import / export CSV ──────────────────────────
// Parser/serializer CSV mínimo (RFC4180: comillas dobles, comas y saltos de
// línea dentro de un campo entre comillas) — no se suma una dependencia
// nueva sólo para esto, el formato de contacto es simple y plano.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Importa filas ya parseadas con header. Columnas esperadas (case-insensitive):
 * telefono/phone/contactid (requerida), nombre/name, canal/channel (default whatsapp),
 * email, tags (separadas por ; o ,).
 * Upsert por contactId: si ya existe, hace merge de nombre/email (sólo si vacíos)
 * y UNIÓN de tags — así reimportar el mismo CSV no pisa tags cargadas a mano.
 */
export async function importCustomersCsv(rows, { normalizePhone } = {}) {
  if (rows.length === 0) return { created: 0, updated: 0, skipped: 0, errors: [] };
  const header = rows[0].map(h => norm(h).trim());
  const idx = (names) => names.map(n => header.indexOf(n)).find(i => i >= 0) ?? -1;
  const iPhone = idx(['telefono', 'phone', 'contactid', 'celular', 'whatsapp']);
  const iName = idx(['nombre', 'name', 'contactname']);
  const iChannel = idx(['canal', 'channel']);
  const iEmail = idx(['email', 'mail', 'correo']);
  const iTags = idx(['tags', 'etiquetas']);

  if (iPhone === -1) {
    const e = new Error('El CSV necesita una columna "telefono" (o "phone"/"contactId") con el identificador del contacto.');
    e.status = 400;
    throw e;
  }

  const db = getDb();
  let created = 0, updated = 0, skipped = 0;
  const errors = [];

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const rawId = (cols[iPhone] ?? '').trim();
    if (!rawId) { skipped++; continue; }
    const channel = (iChannel >= 0 ? cols[iChannel]?.trim() : '') || 'whatsapp';
    const contactId = channel === 'whatsapp' && normalizePhone ? normalizePhone(rawId) : rawId;
    const name = iName >= 0 ? cols[iName]?.trim() || null : null;
    const email = iEmail >= 0 ? cols[iEmail]?.trim() || null : null;
    const tags = iTags >= 0
      ? (cols[iTags] ?? '').split(/[;,]/).map(t => t.trim()).filter(Boolean)
      : [];

    try {
      const docRef = db.collection(COLLECTION).doc(contactId);
      const existing = await docRef.get();
      if (existing.exists) {
        const data = existing.data();
        const mergedTags = [...new Set([...(data.tags ?? []), ...tags])];
        await docRef.update({
          ...(name && !data.contactName ? { contactName: name } : {}),
          ...(email && !data.email ? { email } : {}),
          tags: mergedTags,
          updatedAt: new Date(),
        });
        updated++;
      } else {
        await docRef.set({
          contactId, channel, contactName: name, email,
          firstContactAt: null, lastContactAt: null, agentNotes: '',
          tags, tnCustomerId: null, tnEmail: null, tnOrders: [], tnOrdersUpdatedAt: null,
          source: 'import', createdAt: new Date(), updatedAt: new Date(),
        });
        created++;
      }
    } catch (err) {
      errors.push({ row: r + 1, contactId: rawId, error: err.message });
    }
  }

  return { created, updated, skipped, errors };
}

export async function exportCustomersCsv() {
  const customers = await listCustomers();
  const header = ['contactId', 'canal', 'nombre', 'email', 'tags', 'compras', 'gastado', 'ultimaCompra', 'primeraConsulta', 'ultimaConsulta'];
  const lines = [header.map(csvCell).join(',')];
  for (const c of customers) {
    lines.push([
      c.contactId, c.channel ?? '', c.contactName ?? '', c.email ?? '',
      (c.tags ?? []).join(';'), c.tnOrderCount ?? 0, Math.round(c.tnTotalSpent ?? 0),
      c.tnLastOrderAt ?? '',
      c.firstContactAt ? formatDate(c.firstContactAt) : '',
      c.lastContactAt ? formatDate(c.lastContactAt) : '',
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

// ─────────────────────────── Sync masivo Tienda Nube ─────────────────────
// Trae TODOS los clientes de Tienda Nube que tengan teléfono (aunque nunca
// hayan escrito al bot) y los mete/actualiza en la colección de contactos,
// con su historial de compras para poder segmentarlos.

function mapTnOrder(o) {
  return {
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
  };
}

export async function syncAllTiendaNubeCustomers() {
  const db = getDb();
  const groups = await fetchAllCustomersWithOrders();
  let created = 0, updated = 0, skippedNoPhone = 0;

  for (const { tnCustomer, orders } of groups) {
    const rawPhone = tnCustomer.phone;
    if (!rawPhone || String(rawPhone).replace(/\D/g, '').length < 6) { skippedNoPhone++; continue; }
    const contactId = normalizePhone(rawPhone);
    if (!contactId) { skippedNoPhone++; continue; }

    const sorted = [...orders].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    const tnOrders = sorted.slice(0, 50).map(mapTnOrder);

    const docRef = db.collection(COLLECTION).doc(contactId);
    const existing = await docRef.get();
    if (existing.exists) {
      const data = existing.data();
      await docRef.update({
        tnCustomerId: tnCustomer.id,
        tnEmail: tnCustomer.email ?? data.tnEmail ?? null,
        ...(!data.contactName && tnCustomer.name ? { contactName: tnCustomer.name } : {}),
        ...(!data.email && tnCustomer.email ? { email: tnCustomer.email } : {}),
        tnOrders,
        tnOrdersUpdatedAt: new Date(),
        updatedAt: new Date(),
      });
      updated++;
    } else {
      await docRef.set({
        contactId,
        channel: 'whatsapp',
        contactName: tnCustomer.name ?? null,
        email: tnCustomer.email ?? null,
        firstContactAt: null,
        lastContactAt: null,
        agentNotes: '',
        tags: [],
        tnCustomerId: tnCustomer.id,
        tnEmail: tnCustomer.email ?? null,
        tnOrders,
        tnOrdersUpdatedAt: new Date(),
        source: 'tiendanube',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      created++;
    }
  }

  const result = { scanned: groups.length, created, updated, skippedNoPhone };
  console.log('[customer] Sync Tienda Nube:', JSON.stringify(result));
  return result;
}
