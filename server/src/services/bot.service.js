import { generateBotResponse } from './claude.service.js';
import { getKnowledgeBasePrompt } from './knowledge.service.js';
import {
  getOrCreateConversation,
  appendMessage,
  getConversationHistory,
  updateConversationStatus,
  updateHumanMode,
  updateAssignment,
  dispatchConversation,
  setUrgentFlag,
  addLabelToConversation,
} from './conversation.service.js';
import { findOrder, findOrdersByEmail, formatOrderStatus } from './tiendanube.service.js';
import { findOdooOrder, findOdooOrdersByContact, formatOdooOrder } from './odoo.service.js';
import { sendWhatsAppMessage, sendInstagramMessage, markWhatsAppAsRead, downloadMediaAsBase64 } from './meta.service.js';
import {
  getOrCreateCustomer,
  enrichCustomerFromTiendaNube,
  buildCustomerContext,
  linkCustomerFromOrder,
} from './customer.service.js';
import { getAllLabels, createLabel } from './label.service.js';
import { getActiveDepartments } from './department.service.js';
import { getDb } from './firebase.service.js';

// Captura números Odoo (S08121), TiendaNube (TN1999675391) y números puros
const ORDER_REF = '[A-Z]{0,2}\\d{3,}';
const ORDER_PATTERNS = [
  new RegExp(`pedido\\s*#?\\s*(${ORDER_REF})`, 'i'),
  new RegExp(`orden\\s*#?\\s*(${ORDER_REF})`, 'i'),
  new RegExp(`compra\\s*#?\\s*(${ORDER_REF})`, 'i'),
  new RegExp(`número\\s*#?\\s*(${ORDER_REF})`, 'i'),
  new RegExp(`^(${ORDER_REF})$`, 'i'),
  /tracking/i,
  /donde\s*(está|esta)\s*(mi|el)\s*pedido/i,
  /estado\s*(de|del)\s*(mi|el)?\s*pedido/i,
  /cuándo\s*(llega|llega)/i,
];

const URGENCY_KEYWORDS = [
  /urgente/i, /urgencia/i, /devolución/i, /devolucion/i, /reembolso/i,
  /reclamo/i, /estafa/i, /fraude/i, /nunca llegó/i, /nunca llego/i,
  /muy enojad/i, /indignado/i, /hablar con una persona/i, /quiero hablar/i,
];

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

function parseEscalationMarker(text, departments = []) {
  // Build dynamic markers from active departments
  const markers = departments.map(d => ({
    re: new RegExp(`\\[ESCALAR_${d.id.toUpperCase()}\\]`, 'i'),
    assignTo: d.id,
  }));
  // Always include generic fallback
  markers.push({ re: /\[ESCALAR\]/i, assignTo: null });

  for (const { re, assignTo } of markers) {
    if (!re.test(text)) continue;
    const withoutLine = text.replace(/^[^\n]*\[ESCALAR[^\]]*\][^\n]*\n?/mi, '').trim();
    const cleanText = withoutLine || text.replace(re, '').trim();
    return { shouldEscalate: true, assignTo, cleanText };
  }
  return { shouldEscalate: false, assignTo: null, cleanText: text };
}

function parseCloseMarker(text) {
  if (text.startsWith('[CERRAR]')) {
    return { shouldClose: true, cleanText: text.replace(/^\[CERRAR\]\s*/, '') };
  }
  return { shouldClose: false, cleanText: text };
}

function parseLabelMarkers(text) {
  const labels = [...text.matchAll(/\[LABEL:([^\]]+)\]/g)].map(m => m[1].trim());
  const newLabels = [...text.matchAll(/\[NEW_LABEL:([^\]]+)\]/g)].map(m => m[1].trim());
  const cleanText = text.replace(/\[(NEW_)?LABEL:[^\]]+\]/g, '').trim();
  return { labels, newLabels, cleanText };
}

export async function processIncomingMessage(msg) {
  const { channel, from, messageId, text, type, mediaId, mediaUrl, contactName } = msg;

  if (channel === 'whatsapp' && messageId) {
    markWhatsAppAsRead(messageId).catch(() => {});
  }

  let conversation, history, knowledgeBase, customer, availableLabels, configDoc, departments;
  try {
    [conversation, history, knowledgeBase, customer, availableLabels, configDoc, departments] = await Promise.all([
      getOrCreateConversation(from, channel, contactName),
      getConversationHistory(from),
      getKnowledgeBasePrompt().catch(() => ''),
      getOrCreateCustomer(from, channel, contactName),
      getAllLabels().catch(() => []),
      getDb().collection('bot-altorancho_config').doc('bot_config').get().catch(() => ({ exists: false, data: () => ({}) })),
      getActiveDepartments().catch(() => []),
    ]);
  } catch (err) {
    console.error('[bot] Error cargando contexto para', from, err.message);
    return;
  }
  const botConfig = configDoc.exists ? configDoc.data() : {};
  console.log(`[bot] Contexto cargado para ${from} — humanMode: ${conversation.humanMode}, status: ${conversation.status}`);

  // Auto-reopen archived/resolved conversations when a new message arrives → always goes to bot
  const isArchived = ['resolved', 'bot_archived'].includes(conversation.status)
    || conversation.status === 'urgent'; // legacy urgent status
  if (isArchived && !conversation.humanMode) {
    const previousStatus = conversation.status;
    await Promise.all([
      updateConversationStatus(from, 'bot'),
      updateHumanMode(from, false),
      updateAssignment(from, null),
    ]);
    conversation.status = 'bot';
    conversation.humanMode = false;
    conversation.assignedTo = null;
    console.log(`[bot] Conversación ${from} reabierta automáticamente desde '${previousStatus}'`);
  }

  if (conversation.humanMode) {
    const SAVEABLE_MEDIA = { image: true, audio: true, video: true, document: true, sticker: true };
    if (SAVEABLE_MEDIA[type]) {
      const contentMap = {
        image:    text?.trim() ? `[Imagen] ${text}` : '[Imagen recibida]',
        audio:    '[Audio recibido]',
        video:    '[Video recibido]',
        document: '[Archivo recibido]',
        sticker:  '[Sticker]',
      };
      await appendMessage(from, {
        role: 'user',
        content: contentMap[type],
        mediaType: type,
        mediaId: mediaId ?? null,
        contactName,
      });
    } else if (text?.trim()) {
      await appendMessage(from, { role: 'user', content: text, contactName });
    }
    console.log(`[bot] humanMode activo para ${from} — bot silenciado`);
    return;
  }

  // --- Non-text type handling ---
  if (type === 'audio') {
    const prevAudios = history.filter(m => m.role === 'user' && m.mediaType === 'audio').length;
    const audioUserMsg = '[Audio recibido]';
    await appendMessage(from, { role: 'user', content: audioUserMsg, mediaType: 'audio', mediaId: mediaId ?? null, contactName });

    let reply;
    if (prevAudios >= 1) {
      reply = 'Entiendo que preferís los audios — lamentablemente no puedo escucharlos. ¿Querés que te pase con un agente que pueda ayudarte mejor?';
      await setUrgentFlag(from, true);
    } else {
      reply = 'Hola! Recibí tu audio pero no puedo escucharlo 🎙️ ¿Podés contarme por escrito en qué te ayudo?';
    }
    await appendMessage(from, { role: 'assistant', content: reply });
    if (channel === 'whatsapp') await sendWhatsAppMessage(from, reply);
    else if (channel === 'instagram') await sendInstagramMessage(from, reply);
    return;
  }

  if (type === 'video' || type === 'sticker') {
    if (!text?.trim()) return;
  }

  if (type === 'document') {
    const reply = 'Recibí un archivo, pero no puedo procesarlo directamente. ¿Podés contarme por escrito en qué te ayudo?';
    await appendMessage(from, { role: 'user', content: '[Archivo recibido]', contactName });
    await appendMessage(from, { role: 'assistant', content: reply });
    if (channel === 'whatsapp') await sendWhatsAppMessage(from, reply);
    else if (channel === 'instagram') await sendInstagramMessage(from, reply);
    return;
  }

  // --- Image: download and pass to Claude ---
  let imageData = null;
  if (type === 'image') {
    if (mediaId) {
      imageData = await downloadMediaAsBase64(mediaId).catch(() => null);
    } else if (mediaUrl) {
      try {
        const axios = (await import('axios')).default;
        const { data: buffer } = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        imageData = { base64: Buffer.from(buffer).toString('base64'), mimeType: 'image/jpeg' };
      } catch { /* continue without image */ }
    }
    const userContent = text?.trim() ? `[Imagen] ${text}` : '[Imagen recibida]';
    await appendMessage(from, { role: 'user', content: userContent, mediaType: 'image', mediaId: mediaId ?? null, contactName });
  } else {
    if (!text?.trim()) return;
    await appendMessage(from, { role: 'user', content: text, contactName });
  }

  // Detect urgency keywords and flag (as urgent flag, not status change)
  const isUrgent = text && URGENCY_KEYWORDS.some(re => re.test(text));
  if (isUrgent && !conversation.urgent) {
    setUrgentFlag(from, true).catch(() => {});
  }

  // Check if this is a reopened conversation within 10 days (for context injection)
  const isRecent = conversation.updatedAt
    ? (Date.now() - (conversation.updatedAt._seconds ? conversation.updatedAt._seconds * 1000 : new Date(conversation.updatedAt).getTime())) < TEN_DAYS_MS
    : false;

  const orderInfo = await resolveOrderContext(text ?? '', customer);
  const customerContext = buildCustomerContext(customer);

  if (orderInfo.tnCustomer) {
    linkCustomerFromOrder(from, orderInfo.tnCustomer).catch(err =>
      console.error('[bot] linkCustomer error:', err.message)
    );
  }

  console.log(`[bot] Llamando a Claude para ${from}`);
  const botReply = await generateBotResponse(text ?? '', history, {
    knowledgeBase,
    orderInfo: orderInfo.orderInfo,
    customerContext,
    availableLabels: availableLabels.map(l => l.name),
    botConfig,
    imageData,
    departments,
    isReopened: isRecent && history.length > 0,
  });
  console.log(`[bot] Claude respondió (${botReply.length} chars) para ${from}`);

  const { shouldEscalate, assignTo, cleanText: textAfterEscalation } = parseEscalationMarker(botReply, departments);
  const { shouldClose, cleanText: textAfterClose } = parseCloseMarker(textAfterEscalation);
  const { labels: botLabels, newLabels: botNewLabels, cleanText } = parseLabelMarkers(textAfterClose);

  await appendMessage(from, { role: 'assistant', content: cleanText });

  if (botNewLabels.length > 0) {
    await Promise.all(botNewLabels.map(l => createLabel(l, '#6b7280').then(() => addLabelToConversation(from, l))));
    console.log(`[bot] Nuevas labels creadas y aplicadas a ${from}:`, botNewLabels);
  }
  if (botLabels.length > 0) {
    await Promise.all(botLabels.map(l => addLabelToConversation(from, l)));
    console.log(`[bot] Labels aplicadas a ${from}:`, botLabels);
  }

  if (shouldEscalate) {
    await dispatchConversation(from, {
      status: 'escalated',
      humanMode: true,
      assignedTo: assignTo ?? null,
    });
    console.log(`[bot] Escalando ${from} → agente: ${assignTo ?? 'sin asignar'}`);
  } else if (shouldClose) {
    await updateConversationStatus(from, 'resolved');
    console.log(`[bot] Conversación ${from} resuelta por el bot`);
  }

  if (channel === 'whatsapp') {
    if (!cleanText.trim()) {
      console.warn(`[bot] cleanText vacío para ${from} — no se envía a WPP`);
      return;
    }
    try {
      console.log(`[bot] Enviando WPP a ${from}: ${cleanText.substring(0, 60)}`);
      await sendWhatsAppMessage(from, cleanText);
      console.log(`[bot] WPP enviado OK a ${from}`);
    } catch (sendErr) {
      console.error(`[bot] ERROR enviando WPP a ${from}:`, sendErr.response?.data ?? sendErr.message);
    }
  } else if (channel === 'instagram') {
    if (!cleanText.trim()) return;
    try {
      await sendInstagramMessage(from, cleanText);
    } catch (sendErr) {
      console.error(`[bot] ERROR enviando IG a ${from}:`, sendErr.response?.data ?? sendErr.message);
    }
  }
}

async function resolveOrderContext(text, customer) {
  const trimmed = text.trim();

  if (trimmed.includes('@')) {
    // Buscar en TiendaNube y Odoo en paralelo por email
    const [tnOrders, odooOrders] = await Promise.all([
      findOrdersByEmail(trimmed),
      findOdooOrdersByContact(trimmed),
    ]);
    if (tnOrders.length) {
      const summary = tnOrders.map(o => formatOrderStatus(o)).filter(Boolean);
      return { orderInfo: summary, tnCustomer: tnOrders[0]?.customer ?? null };
    }
    if (odooOrders.length) {
      const summary = odooOrders.map(o => formatOdooOrder(o)).filter(Boolean);
      return { orderInfo: summary, tnCustomer: null };
    }
    return { orderInfo: null, tnCustomer: null };
  }

  for (const pattern of ORDER_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const orderRef = match[1] ?? null;

      if (orderRef) {
        // Buscar en Odoo primero (tiene todos los pedidos incluyendo los de TN)
        // y en TiendaNube en paralelo para obtener tracking URL si existe
        const [odooResult, tnOrder] = await Promise.all([
          findOdooOrder(orderRef),
          /^\d+$/.test(orderRef) ? findOrder(orderRef) : Promise.resolve(null),
        ]);

        if (odooResult) {
          const odooInfo = formatOdooOrder(odooResult.order, odooResult.lines);
          // Enriquecer con tracking de TN si está disponible
          if (tnOrder?.shipping_tracking_url) {
            odooInfo.tracking = tnOrder.shipping_tracking_url;
          }
          return { orderInfo: odooInfo, tnCustomer: tnOrder?.customer ?? null };
        }
        if (tnOrder) {
          return { orderInfo: formatOrderStatus(tnOrder), tnCustomer: tnOrder.customer ?? null };
        }
        return { orderInfo: null, tnCustomer: null };
      }

      // Sin número → usar última orden del perfil del cliente
      const lastNumber = customer?.tnOrders?.[0]?.number;
      if (lastNumber) {
        console.log(`[bot] Sin número en mensaje, usando orden guardada del cliente: #${lastNumber}`);
        const [odooResult, tnOrder] = await Promise.all([
          findOdooOrder(String(lastNumber)),
          findOrder(String(lastNumber)),
        ]);
        if (odooResult) {
          const odooInfo = formatOdooOrder(odooResult.order, odooResult.lines);
          if (tnOrder?.shipping_tracking_url) odooInfo.tracking = tnOrder.shipping_tracking_url;
          return { orderInfo: odooInfo, tnCustomer: tnOrder?.customer ?? null };
        }
        if (tnOrder) {
          return { orderInfo: formatOrderStatus(tnOrder), tnCustomer: tnOrder.customer ?? null };
        }
      }

      return { orderInfo: null, tnCustomer: null };
    }
  }
  return { orderInfo: null, tnCustomer: null };
}
