import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import {
  listConversations,
  listArchivedConversations,
  listWaitingCandidates,
  getConversationById,
  searchConversations,
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
  setMessageTranscript,
} from '../services/conversation.service.js';
import {
  sendWhatsAppMessage,
  sendInstagramMessage,
  sendWhatsAppTemplate,
  sendWhatsAppMedia,
  uploadMetaMedia,
  ensureWhatsAppImageSize,
  getMetaMediaStream,
  downloadMetaMedia,
} from '../services/meta.service.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { createLabel } from '../services/label.service.js';
import { getDb } from '../services/firebase.service.js';
import { generateConversationSummary } from '../services/claude.service.js';
import { toWaContactId } from '../services/phone.js';
import { waitingVisibleTo } from '../services/waiting.js';
import { forwardTargetsAllowed, captionFromContent, FORWARD_MAX_TARGETS, FORWARD_MAX_MESSAGES } from '../services/forward.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// Se mantiene el nombre por compatibilidad con los imports existentes
// (customer.routes.js). La lógica vive en phone.js para que el webhook
// entrante y todos los envíos salientes canonicen el teléfono EXACTAMENTE
// igual — si no, se duplican las conversaciones (ver phone.js).
export function normalizeArgPhone(raw) {
  return toWaContactId(raw);
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
    if (!normalizedPhone || normalizedPhone.length < 10 || normalizedPhone.length > 15) {
      return res.status(400).json({ error: `Número de teléfono inválido: "${normalizedPhone}". Usá formato internacional, ej: 5491112345678` });
    }

    await getOrCreateConversation(normalizedPhone, 'whatsapp', contactName?.trim() || null);

    const msgId = crypto.randomUUID();
    const templateText = params.filter(Boolean).length > 0
      ? `[Plantilla: ${templateName}] ${params.join(' | ')}`
      : `[Plantilla: ${templateName}]`;

    // Save with 'sending' status before attempting send
    await appendMessage(normalizedPhone, { role: 'admin', content: templateText, msgId, msgStatus: 'sending', agentName: req.agent.name, agentEmail: req.agent.email });

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
      await dispatchConversation(normalizedPhone, { status: 'escalated', humanMode: true, assignedTo: createdBy, escalationReason: 'equipo_inicio' });
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

// Búsqueda global: sin límite de 200, sin filtro de departamento, incluye archivadas.
// Debe ir antes de las rutas /:contactId/* para no colisionar con ellas.
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || String(q).trim().length < 2) {
      return res.json({ conversations: [] });
    }
    const conversations = await searchConversations(q);
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conversaciones esperando a alguien del equipo, sin el límite de 200 del
// listado: el panel las suma a su lista para que el chip "Esperando" y "Te
// esperan" coincidan con el contador del menú. Misma regla (isWaiting) y
// misma visibilidad de operador que GET /. Antes de /:contactId.
router.get('/waiting', async (req, res) => {
  try {
    const [candidates, agentsSnap] = await Promise.all([
      listWaitingCandidates(),
      getDb().collection('bot-altorancho_agents').get(),
    ]);
    const agents = agentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ conversations: waitingVisibleTo(candidates, agents, req.agent) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tacho de archivados: todo el historial resolved/bot_archived, sin límite ni
// restricción de departamento. Debe ir antes de las rutas /:contactId/* para
// no colisionar con ellas.
router.get('/archived', async (req, res) => {
  try {
    const conversations = await listArchivedConversations();
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Una conversación puntual por id — la usa el link directo ?open= desde Estadísticas.
router.get('/:contactId', async (req, res) => {
  try {
    const conversation = await getConversationById(req.params.contactId);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json(conversation);
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
      to_bot:       { status: 'bot',          humanMode: false, assignedTo: null, urgent: false },
      bot_archive:  { status: 'bot_archived', humanMode: false, assignedTo: null, urgent: false },
      resolved:     { status: 'resolved',     humanMode: false },
      set_urgent:   { urgent: true },
      unset_urgent: { urgent: false },
    };

    // take_over: assign to the requesting agent
    if (action === 'take_over') {
      if (!agentId) return res.status(400).json({ error: 'agentId requerido para take_over' });
      const patch = { status: 'escalated', humanMode: true, assignedTo: agentId, escalationReason: 'equipo_toma' };
      await dispatchConversation(req.params.contactId, patch);
      return res.json({ ok: true, ...patch });
    }

    // assign_dept: escalate to a department (or agent email)
    if (action === 'assign_dept') {
      const { deptId } = req.body;
      if (!deptId) return res.status(400).json({ error: 'deptId requerido' });
      const patch = { status: 'escalated', humanMode: true, assignedTo: deptId, escalationReason: 'equipo_toma' };
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

// `replyTo` (opcional): { waMsgId, role, preview } de un mensaje anterior que
// el agente eligió citar desde el panel — mismo shape que ya arma
// `resolveReplyTo()` en bot.service.js para las citas entrantes, así el
// front no necesita distinguir cómo se armó.
function sanitizeReplyTo(replyTo) {
  if (!replyTo?.waMsgId || typeof replyTo.waMsgId !== 'string') return null;
  return {
    waMsgId: replyTo.waMsgId,
    role: replyTo.role ?? null,
    preview: String(replyTo.preview ?? '').slice(0, 120),
  };
}

router.post('/:contactId/reply', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { message } = req.body;
    const replyTo = sanitizeReplyTo(req.body.replyTo);

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Mensaje vacío' });
    }

    const db = getDb();
    const doc = await db.collection('bot-altorancho_conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });

    const { channel, status } = doc.data();

    // Si la conversación estaba archivada/resuelta, un agente escribiéndole
    // directo la reabre — si no, queda invisible en Archivados mientras la
    // charla sigue (ver docs/superpowers/specs/2026-08-11-fix-reapertura-archivados-design.md)
    if (status === 'resolved' || status === 'bot_archived') {
      await dispatchConversation(contactId, { status: 'escalated', humanMode: true, assignedTo: req.agent.email, escalationReason: 'equipo_inicio' });
    }

    // Generate a local message ID for tracking delivery status
    const msgId = crypto.randomUUID();

    // Save message immediately with 'sending' status
    await appendMessage(contactId, {
      role: 'admin', content: message.trim(), msgId, msgStatus: 'sending', agentName: req.agent.name, agentEmail: req.agent.email,
      ...(replyTo && { replyTo: { role: replyTo.role, preview: replyTo.preview } }),
    });

    let sendError = null;
    let waMsgId = null;
    let windowExpired = false;
    try {
      if (channel === 'whatsapp') {
        waMsgId = await sendWhatsAppMessage(contactId, message.trim(), replyTo?.waMsgId ?? null);
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

    await appendMessage(contactId, { role: 'admin', content: templateText, msgId, msgStatus: 'sending', agentName: req.agent.name, agentEmail: req.agent.email });

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
    const { channel, status } = doc.data();

    // Mismo criterio que en /reply: mandar un archivo a una conversación
    // archivada la reabre, en vez de dejarla invisible en Archivados.
    if (status === 'resolved' || status === 'bot_archived') {
      await dispatchConversation(contactId, { status: 'escalated', humanMode: true, assignedTo: req.agent.email, escalationReason: 'equipo_inicio' });
    }

    const { buffer, mimetype, originalname } = req.file;
    const mediaType = mimetype.startsWith('audio/') ? 'audio'
      : mimetype.startsWith('video/') ? 'video'
      : mimetype.startsWith('image/') ? 'image'
      : 'document';
    let replyTo = null;
    try { replyTo = sanitizeReplyTo(JSON.parse(req.body.replyTo ?? 'null')); } catch { /* ignora JSON inválido */ }

    const msgId = crypto.randomUUID();
    let sendError = null;
    let windowExpired = false;
    let metaMediaId = null;
    let waMsgId = null;
    try {
      if (channel === 'whatsapp') {
        const { buffer: uploadBuffer, mimeType: uploadMimetype } = mediaType === 'image'
          ? await ensureWhatsAppImageSize(buffer, mimetype)
          : { buffer, mimeType: mimetype };
        metaMediaId = await uploadMetaMedia(uploadBuffer, uploadMimetype);
        if (metaMediaId) waMsgId = await sendWhatsAppMedia(contactId, metaMediaId, uploadMimetype, originalname, replyTo?.waMsgId ?? null);
      }
    } catch (sendErr) {
      windowExpired = channel === 'whatsapp' && isWindowExpiredError(sendErr);
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
      agentName: req.agent.name, agentEmail: req.agent.email,
      ...(waMsgId && { waMsgId }),
      ...(replyTo && { replyTo: { role: replyTo.role, preview: replyTo.preview } }),
    });

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

router.post('/:contactId/media/:mediaId/transcribe', async (req, res) => {
  try {
    const { contactId, mediaId } = req.params;
    const { buffer, mimeType } = await downloadMetaMedia(mediaId);
    const transcript = await transcribeAudio(buffer, mimeType);
    await setMessageTranscript(contactId, mediaId, transcript);
    res.json({ transcript });
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error('[transcribe] Error:', JSON.stringify(detail));
    res.status(502).json({ error: typeof detail === 'object' ? JSON.stringify(detail) : detail });
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

// ---- Reenviar mensajes (como "Reenviar" de WhatsApp) ----
// body: { messages: [{ content, mediaType, mediaId, fileName, mimeType }], targets: [contactId] }
// El origen puede ser WhatsApp o Instagram; los destinos solo WhatsApp con la
// ventana de 24 h abierta (forwardTargetsAllowed). Se reenvía el contenido que
// manda el panel (el agente ya puede escribir cualquier texto con /reply). Los
// archivos se bajan de Meta y se vuelven a subir: los mediaId de mensajes
// ENTRANTES no se pueden reusar para enviar.
const OUT_OF_WINDOW_MSG = 'Fuera de la ventana de 24 hs — hay que mandarle una plantilla primero';
const FORWARD_REJECT_MSG = {
  too_many: `Se puede reenviar a ${FORWARD_MAX_TARGETS} conversaciones como máximo`,
  not_found: 'Conversación no encontrada',
  instagram: 'Por Instagram no se puede reenviar — solo a conversaciones de WhatsApp',
  channel: 'Solo se puede reenviar a conversaciones de WhatsApp',
  window_closed: OUT_OF_WINDOW_MSG,
};

function forwardMediaLabel(mediaType, fileName) {
  return mediaType === 'audio' ? '[Audio enviado]'
    : mediaType === 'video' ? '[Video enviado]'
    : mediaType === 'image' ? '[Imagen enviada]'
    : `[Archivo: ${fileName ?? 'archivo'}]`;
}

router.post('/forward', async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages.slice(0, FORWARD_MAX_MESSAGES) : [];
    const targets = [...new Set(Array.isArray(req.body.targets) ? req.body.targets.filter(t => typeof t === 'string' && t) : [])];
    if (!messages.length || !targets.length) return res.status(400).json({ error: 'Elegí al menos un mensaje y un destinatario' });

    const db = getDb();
    const docs = await Promise.all(targets.slice(0, FORWARD_MAX_TARGETS)
      .map(id => db.collection('bot-altorancho_conversations').doc(id).get()));
    const convsById = new Map(docs.filter(d => d.exists).map(d => [d.id, d.data()]));
    const { allowed, rejected } = forwardTargetsAllowed(targets, convsById, new Date());

    const results = rejected.map(({ id, reason }) => ({
      contactId: id, name: convsById.get(id)?.contactName || id, ok: false, error: FORWARD_REJECT_MSG[reason] ?? reason,
    }));

    // Bajar y subir cada archivo a Meta una sola vez aunque vaya a varios
    // destinatarios (el id subido se puede reusar para varios envíos).
    const uploadCache = new Map();
    function uploadOnce(m) {
      if (!uploadCache.has(m.mediaId)) {
        uploadCache.set(m.mediaId, (async () => {
          const { buffer, mimeType } = await downloadMetaMedia(m.mediaId);
          const mimetype = m.mimeType ?? mimeType;
          const { buffer: upBuffer, mimeType: upMime } = m.mediaType === 'image'
            ? await ensureWhatsAppImageSize(buffer, mimetype)
            : { buffer, mimeType: mimetype };
          const ext = upMime.split('/')[1]?.split(';')[0] ?? 'bin';
          const fileName = m.fileName ?? `${m.mediaType ?? 'archivo'}.${ext}`;
          const mediaId = await uploadMetaMedia(upBuffer, upMime);
          return { mediaId, mimeType: upMime, fileName };
        })());
      }
      return uploadCache.get(m.mediaId);
    }

    const agentFields = { agentName: req.agent.name, agentEmail: req.agent.email, forwarded: true };

    for (const contactId of allowed) {
      const { status, contactName } = convsById.get(contactId);
      const name = contactName || contactId;
      let sentCount = 0;
      let firstError = null;

      for (const m of messages) {
        const hasMedia = !!m.mediaType && m.mediaType !== 'text';
        const text = hasMedia ? captionFromContent(m.content) : String(m.content ?? '').trim();
        try {
          if (hasMedia && m.mediaId) {
            const file = await uploadOnce(m);
            const waMsgId = file.mediaId ? await sendWhatsAppMedia(contactId, file.mediaId, file.mimeType, file.fileName) : null;
            await appendMessage(contactId, {
              role: 'admin', content: forwardMediaLabel(m.mediaType, file.fileName), mediaType: m.mediaType,
              mediaId: file.mediaId ?? null, fileName: file.fileName, msgId: crypto.randomUUID(), msgStatus: 'sent',
              ...agentFields, ...(waMsgId && { waMsgId }),
            });
            sentCount++;
          } else if (hasMedia && !text) {
            // Adjunto sin mediaId (ej. imagen entrante de Instagram): no hay archivo que reenviar.
            throw Object.assign(new Error('Este adjunto no se puede reenviar'), { userMessage: true });
          }
          // El texto (o el pie del adjunto) va como mensaje aparte.
          if (text) {
            const waMsgId = await sendWhatsAppMessage(contactId, text);
            await appendMessage(contactId, {
              role: 'admin', content: text, msgId: crypto.randomUUID(), msgStatus: 'sent',
              ...agentFields, ...(waMsgId && { waMsgId }),
            });
            sentCount++;
          }
        } catch (err) {
          const msg = err.userMessage ? err.message
            : isWindowExpiredError(err) ? OUT_OF_WINDOW_MSG
            : (err.response?.data?.error?.message ?? err.message);
          console.error(`[forward] Error reenviando a ${contactId}:`, msg);
          firstError ??= msg;
        }
      }

      // Mismo criterio que /reply: escribirle a una archivada la reabre.
      if (sentCount > 0 && (status === 'resolved' || status === 'bot_archived')) {
        await dispatchConversation(contactId, { status: 'escalated', humanMode: true, assignedTo: req.agent.email, escalationReason: 'equipo_inicio' });
      }
      results.push({ contactId, name, ok: !firstError, sent: sentCount, ...(firstError && { error: firstError }) });
    }

    res.json({ results });
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
