import { Router } from 'express';
import multer from 'multer';
import {
  listConversations,
  getConversationHistory,
  updateConversationStatus,
  updateHumanMode,
  updateAssignment,
  dispatchConversation,
  markAsRead,
  appendMessage,
  getOrCreateConversation,
  addLabelToConversation,
} from '../services/conversation.service.js';
import {
  sendWhatsAppMessage,
  sendInstagramMessage,
  sendWhatsAppTemplate,
  sendWhatsAppMedia,
  uploadMetaMedia,
  getMetaMediaStream,
} from '../services/meta.service.js';
import { createLabel } from '../services/label.service.js';
import { getDb } from '../services/firebase.service.js';
import { generateConversationSummary } from '../services/claude.service.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// ---- Media proxy (must be before /:contactId routes) ----
router.get('/media/:mediaId', async (req, res) => {
  try {
    await getMetaMediaStream(req.params.mediaId, res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { channel, status, assignedTo } = req.query;
    const conversations = await listConversations({ channel, status, assignedTo });
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Start new conversation (must be before /:contactId routes) ----
router.post('/start', async (req, res) => {
  try {
    const { phone, contactName, templateName, language, params = [], createdBy } = req.body;
    if (!phone?.trim() || !templateName?.trim()) {
      return res.status(400).json({ error: 'phone y templateName requeridos' });
    }
    const normalizedPhone = phone.trim().replace(/[^\d]/g, '');
    const conv = await getOrCreateConversation(normalizedPhone, 'whatsapp', contactName?.trim() || null);
    await sendWhatsAppTemplate(normalizedPhone, templateName, language || 'es_AR', params);
    const templateText = params.length > 0
      ? `[Plantilla: ${templateName}] ${params.join(' | ')}`
      : `[Plantilla: ${templateName}]`;
    await appendMessage(normalizedPhone, { role: 'admin', content: templateText });

    if (createdBy) {
      await dispatchConversation(normalizedPhone, { status: 'escalated', humanMode: true, assignedTo: createdBy });
      await createLabel('Chat creado', '#3b82f6').catch(() => {});
      await addLabelToConversation(normalizedPhone, 'Chat creado');
    }

    const db = getDb();
    const updated = await db.collection('conversations').doc(normalizedPhone).get();
    res.status(201).json({ id: updated.id, ...updated.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:contactId/messages', async (req, res) => {
  try {
    const messages = await getConversationHistory(req.params.contactId);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:contactId/status', async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['bot', 'urgent', 'waiting', 'escalated', 'resolved'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Status inválido. Valores permitidos: ${valid.join(', ')}` });
    }
    await updateConversationStatus(req.params.contactId, status);
    if (status === 'resolved') {
      await updateHumanMode(req.params.contactId, false);
    }
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:contactId/dispatch', async (req, res) => {
  try {
    const { action } = req.body;
    const patches = {
      to_sofia:   { status: 'escalated', humanMode: true,  assignedTo: 'sofia' },
      to_joaquin: { status: 'escalated', humanMode: true,  assignedTo: 'joaquin' },
      to_bot:     { status: 'bot',       humanMode: false, assignedTo: null },
      urgent:     { status: 'urgent' },
      resolved:   { status: 'resolved', humanMode: false },
    };
    const patch = patches[action];
    if (!patch) return res.status(400).json({ error: 'Acción inválida' });
    await dispatchConversation(req.params.contactId, patch);
    res.json({ ok: true, ...patch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:contactId/mode', async (req, res) => {
  try {
    const { humanMode } = req.body;
    await updateHumanMode(req.params.contactId, humanMode);
    res.json({ ok: true, humanMode: !!humanMode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:contactId/assign', async (req, res) => {
  try {
    const { assignedTo } = req.body;
    const valid = ['sofia', 'joaquin', null];
    if (!valid.includes(assignedTo)) {
      return res.status(400).json({ error: 'assignedTo debe ser "sofia", "joaquin" o null' });
    }
    await updateAssignment(req.params.contactId, assignedTo);
    res.json({ ok: true, assignedTo: assignedTo ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:contactId/read', async (req, res) => {
  try {
    await markAsRead(req.params.contactId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:contactId/reply', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Mensaje vacío' });
    }

    const db = getDb();
    const doc = await db.collection('conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });

    const { channel } = doc.data();

    await appendMessage(contactId, { role: 'admin', content: message.trim() });

    let sendError = null;
    try {
      if (channel === 'whatsapp') {
        await sendWhatsAppMessage(contactId, message.trim());
      } else if (channel === 'instagram') {
        await sendInstagramMessage(contactId, message.trim());
      }
    } catch (sendErr) {
      const detail = sendErr.response?.data ?? sendErr.message;
      console.error('[reply] Error enviando por canal:', JSON.stringify(detail));
      sendError = typeof detail === 'object' ? JSON.stringify(detail) : detail;
    }

    if (sendError) {
      return res.status(502).json({ error: `Guardado en panel pero falló el envío: ${sendError}` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:contactId/media', upload.single('file'), async (req, res) => {
  try {
    const { contactId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

    const db = getDb();
    const doc = await db.collection('conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { channel } = doc.data();

    const { buffer, mimetype, originalname } = req.file;
    const mediaType = mimetype.startsWith('audio/') ? 'audio' : mimetype.startsWith('video/') ? 'video' : 'image';

    let sendError = null;
    let metaMediaId = null;
    try {
      if (channel === 'whatsapp') {
        metaMediaId = await uploadMetaMedia(buffer, mimetype);
        if (metaMediaId) await sendWhatsAppMedia(contactId, metaMediaId, mimetype);
      }
    } catch (sendErr) {
      const detail = sendErr.response?.data ?? sendErr.message;
      console.error('[media] Error enviando media:', JSON.stringify(detail));
      sendError = typeof detail === 'object' ? JSON.stringify(detail) : detail;
    }

    const label = mediaType === 'audio' ? '[Audio enviado]' : mediaType === 'video' ? '[Video enviado]' : '[Imagen enviada]';
    await appendMessage(contactId, {
      role: 'admin',
      content: label,
      mediaType,
      mediaId: metaMediaId ?? null,
      fileName: originalname,
    });

    if (sendError) {
      return res.status(502).json({ error: `Guardado en panel pero falló el envío: ${sendError}` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:contactId/summary', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('conversations').doc(req.params.contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json({ summary: doc.data().aiSummary ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:contactId/summary', async (req, res) => {
  try {
    const { contactId } = req.params;
    const db = getDb();
    const [doc, messages] = await Promise.all([
      db.collection('conversations').doc(contactId).get(),
      getConversationHistory(contactId),
    ]);
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });
    const convData = doc.data();
    const metrics = calcConvMetrics(messages, convData);
    const text = await generateConversationSummary(messages);
    const summary = { text, generatedAt: new Date(), metrics };
    await db.collection('conversations').doc(contactId).update({ aiSummary: summary });
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function calcConvMetrics(messages, convData) {
  const responseTimes = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    const userTs = tsToMs(messages[i].timestamp);
    if (!userTs) continue;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === 'user') break;
      const replyTs = tsToMs(messages[j].timestamp);
      if (replyTs && replyTs > userTs) { responseTimes.push(replyTs - userTs); break; }
    }
  }
  const avgMs = responseTimes.length
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : null;
  return {
    totalMessages: messages.length,
    userMessages: messages.filter(m => m.role === 'user').length,
    botMessages: messages.filter(m => m.role === 'assistant').length,
    agentMessages: messages.filter(m => m.role === 'admin').length,
    assignedTo: convData.assignedTo ?? null,
    escalated: !!(convData.humanMode || convData.status === 'escalated'),
    avgResponseTimeSec: avgMs ? Math.round(avgMs / 1000) : null,
  };
}

function tsToMs(ts) {
  if (!ts) return null;
  if (ts._seconds) return ts._seconds * 1000;
  const d = new Date(ts);
  return isNaN(d) ? null : d.getTime();
}

export default router;
