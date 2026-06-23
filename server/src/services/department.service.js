import { getDb } from './firebase.service.js';

const COLLECTION = 'bot-altorancho_departments';

const SEED_DEPARTMENTS = [
  {
    id: 'atencion',
    name: 'Atención al cliente',
    description: 'Consultas generales que el bot no pudo resolver, clientes insatisfechos, dudas sobre productos, tallas o disponibilidad que requieren una persona.',
    active: true,
    order: 1,
  },
  {
    id: 'facturacion',
    name: 'Facturación',
    description: 'Temas de pagos, facturas, reembolsos, cobros incorrectos, problemas con tarjeta o medios de pago.',
    active: true,
    order: 2,
  },
  {
    id: 'logistica',
    name: 'Logística',
    description: 'Envíos, demoras, seguimiento de pedidos online, problemas de entrega, cambios de dirección, pedidos perdidos o dañados.',
    active: true,
    order: 3,
  },
  {
    id: 'belgrano',
    name: 'Local Belgrano',
    description: 'Consultas o reclamos de clientes que compraron o quieren comprar en el local de Belgrano (compra presencial, retiro en tienda, stock del local).',
    active: true,
    order: 4,
  },
  {
    id: 'alcorta',
    name: 'Local Alcorta',
    description: 'Consultas o reclamos de clientes que compraron o quieren comprar en el local de Alcorta (compra presencial, retiro en tienda, stock del local).',
    active: true,
    order: 5,
  },
  {
    id: 'lomas',
    name: 'Local Lomas',
    description: 'Consultas o reclamos de clientes que compraron o quieren comprar en el local de Lomas (compra presencial, retiro en tienda, stock del local).',
    active: true,
    order: 6,
  },
  {
    id: 'mayorista',
    name: 'Mayorista',
    description: 'Clientes que compran al por mayor, preguntan por precios mayoristas, listas de precios, mínimos de compra o condiciones especiales.',
    active: true,
    order: 7,
  },
];

export async function seedDepartmentsIfNeeded() {
  const db = getDb();
  const snap = await db.collection(COLLECTION).limit(1).get();
  if (!snap.empty) return;
  const batch = db.batch();
  for (const dept of SEED_DEPARTMENTS) {
    batch.set(db.collection(COLLECTION).doc(dept.id), { ...dept, createdAt: new Date() });
  }
  await batch.commit();
  console.log('[departments] Seed inicial completado');
}

export async function getAllDepartments() {
  const db = getDb();
  const snap = await db.collection(COLLECTION).orderBy('order').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getActiveDepartments() {
  const db = getDb();
  const snap = await db.collection(COLLECTION).where('active', '==', true).orderBy('order').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function createDepartment({ name, description, active = true }) {
  const db = getDb();
  const snap = await db.collection(COLLECTION).orderBy('order', 'desc').limit(1).get();
  const lastOrder = snap.empty ? 0 : snap.docs[0].data().order ?? 0;
  const id = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const existing = await db.collection(COLLECTION).doc(id).get();
  if (existing.exists) throw new Error('Ya existe un departamento con ese nombre');
  const dept = { id, name, description, active, order: lastOrder + 1, createdAt: new Date() };
  await db.collection(COLLECTION).doc(id).set(dept);
  return dept;
}

export async function updateDepartment(id, { name, description, active }) {
  const db = getDb();
  const update = { updatedAt: new Date() };
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (active !== undefined) update.active = active;
  await db.collection(COLLECTION).doc(id).update(update);
  const doc = await db.collection(COLLECTION).doc(id).get();
  return { id: doc.id, ...doc.data() };
}

export async function deleteDepartment(id) {
  await getDb().collection(COLLECTION).doc(id).delete();
}
