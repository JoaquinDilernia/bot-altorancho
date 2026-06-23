import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { getDb } from './firebase.service.js';

const COLLECTION = 'bot-altorancho_agents';

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

function docId(email) {
  return email.toLowerCase().trim();
}

function toPublic(data) {
  return {
    id: data.id,
    email: data.email,
    name: data.name,
    role: data.role ?? 'operador',
    department: data.department ?? null,
  };
}

export async function seedAgentsIfNeeded() {
  const db = getDb();
  const adminEmail = 'joaquin.dilernia@altorancho.com';
  const id = docId(adminEmail);
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) {
    await db.collection(COLLECTION).doc(id).set({
      id,
      email: adminEmail,
      name: 'Joaquín Di Lernia',
      role: 'admin',
      passwordHash: hashPassword('altolett123'),
      createdAt: new Date(),
    });
    console.log('[auth] Admin seedeado:', adminEmail);
  } else if (!doc.data().role) {
    await db.collection(COLLECTION).doc(id).update({ role: 'admin' });
    console.log('[auth] Admin migrado a role: admin');
  }
}

export async function validateCredentials(email, password) {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(docId(email)).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (data.passwordHash !== hashPassword(password)) return null;
  return toPublic(data);
}

export async function createUser({ email, name, password, role = 'operador', department = null }) {
  const db = getDb();
  const id = docId(email);
  const existing = await db.collection(COLLECTION).doc(id).get();
  if (existing.exists) throw new Error('El email ya está registrado');
  const user = { id, email: email.toLowerCase().trim(), name, role, department, passwordHash: hashPassword(password), createdAt: new Date() };
  await db.collection(COLLECTION).doc(id).set(user);
  return toPublic(user);
}

export async function listUsers() {
  const db = getDb();
  const snap = await db.collection(COLLECTION).orderBy('createdAt').get();
  return snap.docs.map(d => toPublic(d.data()));
}

export async function deleteUser(id) {
  const db = getDb();
  await db.collection(COLLECTION).doc(docId(id)).delete();
}

export async function updateUser(id, { name, role, department } = {}) {
  const db = getDb();
  const update = { updatedAt: new Date() };
  if (name) update.name = name;
  if (role) update.role = role;
  if (department !== undefined) update.department = department;
  await db.collection(COLLECTION).doc(docId(id)).update(update);
  const doc = await db.collection(COLLECTION).doc(docId(id)).get();
  return toPublic(doc.data());
}

export async function getAgentById(id) {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(docId(id)).get();
  if (!doc.exists) return null;
  return toPublic(doc.data());
}

export async function updateProfile(agentId, { name, password } = {}) {
  const db = getDb();
  const update = { updatedAt: new Date() };
  if (name) update.name = name;
  if (password) update.passwordHash = hashPassword(password);
  await db.collection(COLLECTION).doc(agentId).update(update);
  const doc = await db.collection(COLLECTION).doc(agentId).get();
  return toPublic(doc.data());
}

export function generateToken(agent) {
  return jwt.sign(
    { id: agent.id, email: agent.email, name: agent.name, role: agent.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}
