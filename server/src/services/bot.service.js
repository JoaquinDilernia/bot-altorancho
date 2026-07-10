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
import { findOrder, findOrdersByEmail, getOrderById as getTNOrderById, formatOrderStatus } from './tiendanube.service.js';
import { findOdooOrder, findOdooOrdersByContact, findOdooOrdersByName, formatOdooOrder, getStockBySku, formatStockInfo } from './odoo.service.js';
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
  new RegExp(`^#?(${ORDER_REF})$`, 'i'),
  /tracking/i,
  /donde\s*(está|esta)\s*(mi|el)\s*pedido/i,
  /estado\s*(de|del)\s*(mi|el)?\s*pedido/i,
  /cuándo\s*(llega|llega)/i,
];

const STOCK_PATTERNS = [
  /\bstock\b/i,
  /\bdisponib/i,
  /\bexhibici/i,
  /tienen\s+(?:el|la|los|las)\s+\w/i,
  /hay\s+(?:algún|alguna|algun|alguna)\b/i,
  /en\s+(?:el\s+)?local/i,
  /en\s+belgrano/i,
  /en\s+(?:las?\s*)?lomas/i,
  /en\s+alcorta/i,
  /en\s+rol[oó]n/i,
  /en\s+sucursal/i,
  /en\s+(?:la\s+)?tienda/i,
];

const URGENCY_KEYWORDS = [
  /urgente/i, /urgencia/i, /devolución/i, /devolucion/i, /reembolso/i,
  /reclamo/i, /estafa/i, /fraude/i, /nunca llegó/i, /nunca llego/i,
  /muy enojad/i, /indignado/i, /hablar con una persona/i, /quiero hablar/i,
];

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

// Returns true if current Argentina time is within business hours
export function isWithinBusinessHours(botConfig = {}) {
  const tz = 'America/Argentina/Buenos_Aires';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const day = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeMin = hour * 60 + minute;

  const startH = botConfig.businessHoursStart ?? 9;
  const endH   = botConfig.businessHoursEnd   ?? 18;
  const days   = botConfig.businessDays        ?? [1, 2, 3, 4, 5]; // lun-vie

  return days.includes(day) && timeMin >= startH * 60 && timeMin < endH * 60;
}

function buildEscalationMessage(deptName, botConfig = {}) {
  const within = isWithinBusinessHours(botConfig);
  const startH = botConfig.businessHoursStart ?? 9;
  const endH   = botConfig.businessHoursEnd   ?? 18;
  const hoursStr = `${startH}:00 a ${endH}:00hs, lunes a viernes`;

  if (within) {
    return `Tu consulta fue derivada a *${deptName}* 👋\n\nUn agente va a atenderte en breve. Por favor aguardá unos minutos.\n\n🕐 Horario de atención: ${hoursStr}.`;
  } else {
    return `Tu consulta fue derivada a *${deptName}* 👋\n\nEn este momento estamos fuera del horario de atención (${hoursStr}). Tu mensaje fue registrado y un agente te va a responder cuando retomemos.\n\n¡Gracias por tu paciencia!`;
  }
}

function parseEscalationMarker(text, departments = []) {
  // Build dynamic markers from active departments
  const markers = departments.map(d => ({
    re: new RegExp(`\\[ESCALAR_${d.id.toUpperCase()}\\]`, 'i'),
    assignTo: d.id,
  }));
  // Generic fallback always routes to atencion (never leaves assignedTo null)
  markers.push({ re: /\[ESCALAR\]/i, assignTo: 'atencion' });

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
      getActiveDepartments().then(d => d.filter(dep => dep.id !== 'admin')).catch(() => []),
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

  const [orderContext, stockInfo] = await Promise.all([
    resolveOrderContext(text ?? '', customer, conversation),
    resolveStockContext(text ?? ''),
  ]);
  const customerContext = buildCustomerContext(customer);

  if (orderContext.tnCustomer) {
    linkCustomerFromOrder(from, orderContext.tnCustomer).catch(err =>
      console.error('[bot] linkCustomer error:', err.message)
    );
  }

  if (orderContext.orderRef) {
    getDb().collection('bot-altorancho_conversations').doc(from)
      .update({ lastOrderRef: orderContext.orderRef })
      .catch(() => {});
  }

  console.log(`[bot] Llamando a Claude para ${from}`);
  const botReply = await generateBotResponse(text ?? '', history, {
    knowledgeBase,
    orderInfo: orderContext.orderInfo,
    stockInfo,
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

    // Mensaje automático al cliente informando la derivación
    const deptName = departments.find(d => d.id === assignTo)?.name ?? 'Atención al cliente';
    const escalationMsg = buildEscalationMessage(deptName, botConfig);
    if (escalationMsg) {
      try {
        await appendMessage(from, { role: 'assistant', content: escalationMsg });
        if (channel === 'whatsapp') await sendWhatsAppMessage(from, escalationMsg);
        else if (channel === 'instagram') await sendInstagramMessage(from, escalationMsg);
      } catch (err) {
        console.error('[bot] Error enviando mensaje de escalación:', err.message);
      }
    }
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

async function resolveStockContext(text) {
  if (!text || !STOCK_PATTERNS.some(re => re.test(text))) return null;

  try {
    const products = await searchProducts(text);
    if (!products?.length) return null;

    let sku = null;
    let productName = null;
    for (const p of products) {
      const variants = p.variants ?? [];
      const withSku = variants.find(v => v.sku);
      if (withSku) {
        sku = withSku.sku;
        const n = p.name;
        productName = typeof n === 'string' ? n
          : (n?.es ?? n?.en ?? Object.values(n ?? {})[0] ?? 'Producto');
        break;
      }
    }

    if (!sku) return null;

    const stockResult = await getStockBySku(sku);
    console.log(`[bot] stock para SKU ${sku}:`, stockResult);
    return formatStockInfo(productName, sku, stockResult);
  } catch (err) {
    console.error('[bot] resolveStockContext error:', err.message);
    return null;
  }
}

async function resolveOrderContext(text, customer, conversation = {}) {
  const trimmed = text.trim();

  if (trimmed.includes('@')) {
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
        const result = await searchOrderByRef(orderRef);
        return { ...result, orderRef };
      }

      // Sin número → priorizar la última orden mencionada en esta conversación,
      // luego la del perfil del cliente
      const fallbackRef = conversation.lastOrderRef ?? String(customer?.tnOrders?.[0]?.number ?? '');
      if (fallbackRef) {
        console.log(`[bot] Sin número en mensaje, usando orden del contexto: #${fallbackRef}`);
        const result = await searchOrderByRef(fallbackRef);
        return { ...result, orderRef: fallbackRef };
      }

      return { orderInfo: null, tnCustomer: null };
    }
  }
  return { orderInfo: null, tnCustomer: null };
}

/**
 * Enruta la búsqueda de un pedido según el formato de la referencia:
 *
 * - Número puro (51689)    → TiendaNube primero (número visible para el cliente en pedidos web)
 *                            Si TN lo encuentra, intenta enriquecer con Odoo via TN{id_interno}
 *                            Si TN no lo encuentra, fallback a Odoo (puede ser local con número numérico)
 * - S-prefijo (S08121)     → Odoo directo (pedido de local físico)
 * - TN-prefijo (TN123...)  → Odoo directo (referencia interna de pedido web importado)
 * - Alfanumérico genérico  → Odoo directo
 */
async function searchOrderByRef(orderRef) {
  const isPureNumber = /^\d+$/.test(orderRef);
  const isOdooLocal  = /^S\d+$/i.test(orderRef);
  const isOdooTN     = /^TN\d+$/i.test(orderRef);

  // --- Número puro: pedido web de TiendaNube ---
  if (isPureNumber) {
    const tnOrder = await findOrder(orderRef);

    if (tnOrder) {
      console.log(`[bot] Pedido #${orderRef} encontrado en TiendaNube (TN id: ${tnOrder.id})`);
      const tnFormatted = formatOrderStatus(tnOrder);

      // Intentar enriquecer con Odoo usando el ID interno de TiendaNube
      try {
        const odooResult = await findOdooOrder(`TN${tnOrder.id}`);
        if (odooResult) {
          const odooInfo = formatOdooOrder(odooResult.order, odooResult.lines);
          if (tnOrder.shipping_tracking_url) odooInfo.tracking = tnOrder.shipping_tracking_url;
          return { orderInfo: odooInfo, tnCustomer: tnOrder.customer ?? null };
        }
      } catch (err) {
        console.warn(`[bot] No se pudo enriquecer TN${tnOrder.id} en Odoo:`, err.message);
      }

      return { orderInfo: tnFormatted, tnCustomer: tnOrder.customer ?? null };
    }

    // Fallback: puede ser un pedido de local con número numérico en Odoo
    console.log(`[bot] Pedido #${orderRef} no encontrado en TiendaNube, buscando en Odoo...`);
    const odooResult = await findOdooOrder(orderRef);
    if (odooResult) {
      return { orderInfo: formatOdooOrder(odooResult.order, odooResult.lines), tnCustomer: null };
    }

    return { orderInfo: null, tnCustomer: null };
  }

  // --- Referencia de Odoo (S... o TN...) ---
  if (isOdooLocal || isOdooTN) {
    const odooResult = await findOdooOrder(orderRef);
    if (odooResult) {
      const odooInfo = formatOdooOrder(odooResult.order, odooResult.lines);
      // Si es un pedido TN en Odoo, intentar obtener tracking URL desde TiendaNube
      if (isOdooTN) {
        const tnId = orderRef.replace(/^TN/i, '');
        try {
          const tnOrder = await getTNOrderById(tnId);
          if (tnOrder?.shipping_tracking_url) odooInfo.tracking = tnOrder.shipping_tracking_url;
        } catch { /* tracking es opcional */ }
      }
      return { orderInfo: odooInfo, tnCustomer: null };
    }
    return { orderInfo: null, tnCustomer: null };
  }

  // --- Alfanumérico genérico → Odoo ---
  const odooResult = await findOdooOrder(orderRef);
  if (odooResult) {
    return { orderInfo: formatOdooOrder(odooResult.order, odooResult.lines), tnCustomer: null };
  }
  return { orderInfo: null, tnCustomer: null };
}
