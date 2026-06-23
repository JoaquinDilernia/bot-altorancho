import { getDb } from './firebase.service.js';
import admin from 'firebase-admin';

const COLLECTION = 'bot-altorancho_conversations';

// Valid statuses: bot, escalated, bot_archived, resolved
// 'urgent' is now a boolean flag (data.urgent), not a status
// Legacy docs with status === 'urgent' are treated as status: 'bot', urgent: true

export async function getOrCreateConversation(contactId, channel, contactName = null) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);
  const doc = await docRef.get();

  if (doc.exists) {
    const data = doc.data();
    if (contactName && !data.contactName) {
      await docRef.update({ contactName });
    }
    return { id: doc.id, ...data };
  }

  const newConversation = {
    contactId,
    channel,
    contactName: contactName ?? null,
    messages: [],
    status: 'bot',
    humanMode: false,
    assignedTo: null,
    urgent: false,
    unread: 0,
    consecutiveClientMessages: 0,
    lastClientMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await docRef.set(newConversation);
  return { id: contactId, ...newConversation };
}

export async function appendMessage(contactId, message) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);

  const doc = await docRef.get();
  const current = doc.exists ? doc.data().messages ?? [] : [];
  const updated = [...current, { ...message, timestamp: new Date() }].slice(-200);

  const extra = {};
  if (message.role === 'user') {
    extra.unread = admin.firestore.FieldValue.increment(1);
    extra.lastClientMessageAt = new Date();
    extra.consecutiveClientMessages = admin.firestore.FieldValue.increment(1);
  } else {
    // Any non-user message (bot or agent) resets the consecutive counter
    extra.consecutiveClientMessages = 0;
  }

  await docRef.update({ messages: updated, updatedAt: new Date(), ...extra });
}

export async function getConversationHistory(contactId) {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(contactId).get();
  return doc.exists ? doc.data().messages ?? [] : [];
}

export async function updateConversationStatus(contactId, status) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({
    status,
    updatedAt: new Date(),
  });
}

export async function updateHumanMode(contactId, humanMode) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({
    humanMode: !!humanMode,
    updatedAt: new Date(),
  });
}

export async function updateAssignment(contactId, assignedTo) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({
    assignedTo: assignedTo ?? null,
    updatedAt: new Date(),
  });
}

export async function setUrgentFlag(contactId, urgent) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({
    urgent: !!urgent,
    updatedAt: new Date(),
  });
}

export async function dispatchConversation(contactId, patch) {
  const db = getDb();
  const update = { updatedAt: new Date() };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.humanMode !== undefined) update.humanMode = !!patch.humanMode;
  if (patch.assignedTo !== undefined) update.assignedTo = patch.assignedTo ?? null;
  if (patch.urgent !== undefined) update.urgent = !!patch.urgent;
  await db.collection(COLLECTION).doc(contactId).update(update);
}

export async function addLabelToConversation(contactId, label) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({
    labels: admin.firestore.FieldValue.arrayUnion(label),
    updatedAt: new Date(),
  });
}

export async function removeLabelFromConversation(contactId, label) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({
    labels: admin.firestore.FieldValue.arrayRemove(label),
    updatedAt: new Date(),
  });
}

export async function markAsRead(contactId) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({ unread: 0 });
}

// Update a specific message's delivery status by local msgId
export async function updateMessageStatus(contactId, msgId, newStatus, waMsgId = null) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);
  const doc = await docRef.get();
  if (!doc.exists) return;
  const messages = doc.data().messages ?? [];
  const updated = messages.map(m => {
    if (m.msgId !== msgId) return m;
    const result = { ...m, msgStatus: newStatus };
    if (waMsgId) result.waMsgId = waMsgId;
    return result;
  });
  await docRef.update({ messages: updated });
}

// Update a specific message's delivery status by WA message ID (for webhook delivery receipts)
export async function updateMessageStatusByWaMsgId(waMsgId, newStatus) {
  const db = getDb();
  const snap = await db.collection(COLLECTION)
    .where('lastWaMsgId', '==', waMsgId)
    .limit(1)
    .get();
  if (snap.empty) return;
  const docRef = snap.docs[0].ref;
  const messages = snap.docs[0].data().messages ?? [];
  const updated = messages.map(m => {
    if (m.waMsgId !== waMsgId) return m;
    return { ...m, msgStatus: newStatus };
  });
  await docRef.update({ messages: updated });
}

export async function listConversations(filters = {}) {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION).orderBy('updatedAt', 'desc').limit(200).get();

  let docs = snapshot.docs.map((doc) => {
    const data = doc.data();
    const lastMsg = data.messages?.slice(-1)[0];

    // Legacy support: status === 'urgent' treated as status: 'bot', urgent: true
    const rawStatus = data.status ?? 'bot';
    const effectiveStatus = rawStatus === 'urgent' ? 'bot' : rawStatus;
    const isUrgent = data.urgent === true || rawStatus === 'urgent';

    return {
      id: doc.id,
      contactId: data.contactId,
      contactName: data.contactName ?? null,
      channel: data.channel,
      status: effectiveStatus,
      humanMode: data.humanMode ?? false,
      assignedTo: data.assignedTo ?? null,
      urgent: isUrgent,
      unread: data.unread ?? 0,
      labels: data.labels ?? [],
      messageCount: data.messages?.length ?? 0,
      lastMessage: lastMsg?.content ?? '',
      lastMessageAt: lastMsg?.timestamp ?? data.updatedAt,
      lastClientMessageAt: data.lastClientMessageAt ?? null,
      consecutiveClientMessages: data.consecutiveClientMessages ?? 0,
      updatedAt: data.updatedAt,
      createdAt: data.createdAt,
    };
  });

  if (filters.channel) docs = docs.filter(d => d.channel === filters.channel);
  if (filters.status)  docs = docs.filter(d => d.status === filters.status);
  if (filters.assignedTo) {
    const targets = Array.isArray(filters.assignedTo) ? filters.assignedTo : [filters.assignedTo];
    docs = docs.filter(d => targets.includes(d.assignedTo));
  }

  return docs;
}
