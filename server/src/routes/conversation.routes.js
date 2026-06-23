import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import {
  listConversations,
  getConversationHistory,
  updateConversationStatus,
  updateHumanMode,
  updateAssignment,
  dispatchConversation,
  setUrgentFlag,
  markAsRead,
  appendMessage,
  getOrCreateConversation,
  addLabelToConversation,
  updateMessageStatus,
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

// Normalizes Argentine mobile numbers to E.164 without '+' for the WhatsApp API.
// Accepts: 5491112345678 | +5491112345678 | 1112345678 | 01112345678 | 91112345678
function normalizeArgPhone(raw) {
  let d = raw.trim().replace(/[^\d]/g, '');
  if (d.startsWith('54')) return d;           // already has country code
  if (d.startsWith('0')) d = d.slice(1);      // strip local trunk 0
  if (d.startsWith('9') && d.length === 11) return `54${d}`;   // 9 + area + number
  if (d.length === 10) return `549${d}`;      // area (2-4 digits) + number, add mobile 9
  return `54${d}`;                            // fallback: just prepend country code
}

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
    // operador sees conversations assigned to their department (bot escalation) OR directly to their email
    const assignedToFilter = req.agent.role === 'operador'
      ? [req.agent.department, req.agent.email].filter(Boolean)
      : (assignedTo ?? undefined);
    const conversations = await listConversations({ channel, status, assignedTo: assignedToFilter });
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
    const normalizedPhone = normalizeArgPhone(phone);
    if (normalizedPhone.length < 10 || normalizedPhone.length > 15) {
      return res.status(400).json({ error: `Número de teléfono inválido: "${normalizedPhone}". Usá formato internacional, ej: 5491112345678` });
    }

    await getOrCreateConversation(normalizedPhone, 'whatsapp', contactName?.trim() || null);

    const msgId = crypto.randomUUID();
    const templateText = params.filter(Boolean).length > 0
      ? `[Plantilla: ${templateName}] ${params.join(' | ')}`
      : `[Plantilla: ${templateName}]`;

    // Save with 'sending' status before attempting send
    await appendMessage(normalizedPhone, { role: 'admin', content: templateText, msgId, msgStatus: 'sending' });

    let sendError = null;
    let waMsgId = null;
    try {
      waMsgId = await sendWhatsAppTemplate(normalizedPhone, templateName, language || 'es_AR', params);
    } catch (sendErr) {
      // Extract the real Meta error message, not the axios wrapper
      const metaMsg = sendErr.response?.data?.error?.message;
      const metaCode = sendErr.response?.data?.error?.code;
      sendError = metaMsg
        ? `Meta error ${metaCode ?? ''}: ${metaMsg}`
        : sendErr.message;
      console.error('[start] Error enviando template:', sendError);
    }

    await updateMessageStatus(normalizedPhone, msgId, sendError ? 'error' : 'sent', waMsgId).catch(() => {});

    if (sendError) {
      return res.status(502).json({ error: `No se pudo enviar la plantilla: ${sendError}` });
    }

    if (createdBy) {
      await dispatchConversation(normalizedPhone, { status: 'escalated', humanMode: true, assignedTo: createdBy });
      await createLabel('Chat creado', '#3b82f6').catch(() => {});
      await addLabelToConversation(normalizedPhone, 'Chat creado');
    }

    const db = getDb();
    const updated = await db.collection('bot-altorancho_conversations').doc(normalizedPhone).get();
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
    const valid = ['bot', 'escalated', 'bot_archived', 'resolved'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Status inválido. Valores permitidos: ${valid.join(', ')}` });
    }
    await updateConversationStatus(req.params.contactId, status);
    if (status === 'resolved' || status === 'bot_archived') {
      await updateHumanMode(req.params.contactId, false);
    }
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:contactId/dispatch', async (req, res) => {
  try {
    const { action, agentId } = req.body;

    const patches = {
      to_sofia:     { status: 'escalated', humanMode: true,  assignedTo: 'sofia' },
      to_joaquin:   { status: 'escalated', humanMode: true,  assignedTo: 'joaquin' },
      to_bot:       { status: 'bot',       humanMode: false, assignedTo: null, urgent: false },
      bot_archive:  { status: 'bot_archived', humanMode: false, assignedTo: null, urgent: false },
      resolved:     { status: 'resolved',  humanMode: false },
      set_urgent:   { urgent: true },
      unset_urgent: { urgent: false },
    };

    // take_over: assign to the requesting agent
    if (action === 'take_over') {
      if (!agentId) return res.status(400).json({ error: 'agentId requerido para take_over' });
      const patch = { status: 'escalated', humanMode: true, assignedTo: agentId };
      await dispatchConversation(req.params.contactId, patch);
      return res.json({ ok: true, ...patch });
    }

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
    if (assignedTo !== null && typeof assignedTo !== 'string') {
      return res.status(400).json({ error: 'assignedTo debe ser un string (email o id de departamento) o null' });
    }
    await updateAssignment(req.params.contactId, assignedTo ?? null);
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

// Meta error codes that indicate the 24h customer service window has expired
const WA_WINDOW_EXPIRED_CODES = new Set([131047, 131026, 132000, 130429]);

function isWindowExpiredError(sendErr) {
  const code = sendErr.response?.data?.error?.code;
  const msg = sendErr.response?.data?.error?.message ?? '';
  return WA_WINDOW_EXPIRED_CODES.has(code) || msg.toLowerCase().includes('window');
}

router.post('/:contactId/reply', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Mensaje vacío' });
    }

    const db = getDb();
    const doc = await db.collection('bot-altorancho_conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });

    const { channel } = doc.data();

    // Generate a local message ID for tracking delivery status
    const msgId = crypto.randomUUID();

    // Save message immediately with 'sending' status
    await appendMessage(contactId, { role: 'admin', content: message.trim(), msgId, msgStatus: 'sending' });

    let sendError = null;
    let waMsgId = null;
    let windowExpired = false;
    try {
      if (channel === 'whatsapp') {
        waMsgId = await sendWhatsAppMessage(contactId, message.trim());
      } else if (channel === 'instagram') {
        await sendInstagramMessage(contactId, message.trim());
      }
    } catch (sendErr) {
      windowExpired = channel === 'whatsapp' && isWindowExpiredError(sendErr);
      const detail = sendErr.response?.data ?? sendErr.message;
      console.error('[reply] Error enviando por canal:', JSON.stringify(detail));
      sendError = typeof detail === 'object' ? JSON.stringify(detail) : detail;
    }

    // Update message delivery status
    await updateMessageStatus(contactId, msgId, sendError ? 'error' : 'sent', waMsgId).catch(() => {});

    if (sendError) {
      return res.status(502).json({
        error: windowExpired
          ? 'La ventana de WhatsApp de 24hs expiró. Necesitás enviar una plantilla aprobada para retomar la conversación.'
          : `Guardado en panel pero falló el envío: ${sendError}`,
        windowExpired,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send an approved template to an existing conversation (to reopen the 24h window)
router.post('/:contactId/send-template', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { templateName, language, params = [] } = req.body;

    if (!templateName?.trim()) {
      return res.status(400).json({ error: 'templateName requerido' });
    }

    const db = getDb();
    const doc = await db.collection('bot-altorancho_conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });

    const { channel } = doc.data();
    if (channel !== 'whatsapp') {
      return res.status(400).json({ error: 'Las plantillas de reactivación solo funcionan en WhatsApp' });
    }

    const msgId = crypto.randomUUID();
    const templateText = params.filter(Boolean).length > 0
      ? `[Plantilla: ${templateName}] ${params.join(' | ')}`
      : `[Plantilla: ${templateName}]`;

    await appendMessage(contactId, { role: 'admin', content: templateText, msgId, msgStatus: 'sending' });

    let sendError = null;
    let waMsgId = null;
    try {
      waMsgId = await sendWhatsAppTemplate(contactId, templateName, language || 'es_AR', params);
    } catch (sendErr) {
      const detail = sendErr.response?.data ?? sendErr.message;
      console.error('[send-template] Error:', JSON.stringify(detail));
      sendError = typeof detail === 'object' ? JSON.stringify(detail) : detail;
    }

    await updateMessageStatus(contactId, msgId, sendError ? 'error' : 'sent', waMsgId).catch(() => {});

    if (sendError) {
      return res.status(502).json({ error: `No se pudo enviar la plantilla: ${sendError}` });
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
    const doc = await db.collection('bot-altorancho_conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { channel } = doc.data();

    const { buffer, mimetype, originalname } = req.file;
    const mediaType = mimetype.startsWith('audio/') ? 'audio'
      : mimetype.startsWith('video/') ? 'video'
      : mimetype.startsWith('image/') ? 'image'
      : 'document';

    const msgId = crypto.randomUUID();
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

    const label = mediaType === 'audio' ? '[Audio enviado]'
      : mediaType === 'video' ? '[Video enviado]'
      : mediaType === 'document' ? `[Archivo: ${originalname}]`
      : '[Imagen enviada]';

    await appendMessage(contactId, {
      role: 'admin',
      content: label,
      mediaType,
      mediaId: metaMediaId ?? null,
      fileName: originalname,
      msgId,
      msgStatus: sendError ? 'error' : 'sent',
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
    const doc = await db.collection('bot-altorancho_conversations').doc(req.params.contactId).get();
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
      db.collection('bot-altorancho_conversations').doc(contactId).get(),
      getConversationHistory(contactId),
    ]);
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });
    const convData = doc.data();
    const metrics = calcConvMetrics(messages, convData);
    const text = await generateConversationSummary(messages);
    const summary = { text, generatedAt: new Date(), metrics };
    await db.collection('bot-altorancho_conversations').doc(contactId).update({ aiSummary: summary });
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
