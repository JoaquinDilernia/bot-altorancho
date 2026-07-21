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
  setMenuState,
} from './conversation.service.js';
import { findOrder, findOrdersByEmail, getOrderById as getTNOrderById, formatOrderStatus, searchProducts } from './tiendanube.service.js';
import { findOdooOrder, findOdooOrdersByContact, findOdooOrdersByName, formatOdooOrder, getStockBySku, formatStockInfo } from './odoo.service.js';
import { sendWhatsAppMessage, sendInstagramMessage, markWhatsAppAsRead, downloadMediaAsBase64, sendWhatsAppInteractiveList, sendWhatsAppInteractiveButtons } from './meta.service.js';
import {
  getOrCreateCustomer,
  enrichCustomerFromTiendaNube,
  buildCustomerContext,
  linkCustomerFromOrder,
} from './customer.service.js';
import { getAllLabels, createLabel } from './label.service.js';
import { getActiveDepartments } from './department.service.js';
import { getDb } from './firebase.service.js';

// Captura números Odoo (S08121), TiendaNube (TN1999675391) y números puros.
// El número puede venir con o sin "#" y en cualquier parte del mensaje — NO
// hace falta que esté pegado a la palabra clave (ej: "mi pedido es el 20610"
// o "el número de pedido es #20610" tienen que encontrar el 20610 igual que
// "pedido #20610").
const ORDER_REF = '[A-Z]{0,2}\\d{3,}';
const ORDER_REF_TOKEN = new RegExp(`#?(${ORDER_REF})\\b`, 'i');
const ORDER_BARE_NUMBER = new RegExp(`^#?(${ORDER_REF})$`, 'i');
const ORDER_KEYWORD = /\b(pedido|orden|compra|n[uú]mero)\b/i;
// Menciones de una compra sin número (frecuente en compras de local físico,
// que el cliente no suele identificar con un número de pedido) — van directo
// al flujo de "sin número" sin necesidad de encontrar un token de dígitos.
const ORDER_INTENT_NO_NUMBER_PATTERNS = [
  /tracking/i,
  /donde\s*(está|esta)\s*(mi|el)\s*pedido/i,
  /estado\s*(de|del)\s*(mi|el)?\s*pedido/i,
  /cuándo\s*(llega|llega)/i,
  /mi\s+compra\b/i,
  /compr[eé]\s+(?:algo|un|una|el|la)\b/i,
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

// SKU propio: letras + dígitos + letras (ej: IME054CH, DOF126RS). El dígito en
// el medio lo distingue de una palabra común, así que alcanza como señal de
// intención aunque el mensaje no traiga ninguna palabra clave de stock — pasa
// seguido cuando el bot ya preguntó "¿qué producto?" y el cliente responde
// solo con el SKU.
const SKU_PATTERN = /\b[A-Z]{2,5}\d{2,5}[A-Z]{1,5}\b/i;

// --- Flujo guiado por menú (bot_config.flowMode === 'menu') ---
const ENTRY_MENU_BODY = '¡Hola! 👋 Elegí una opción para que te pueda ayudar más rápido:';
const ENTRY_MENU_BUTTON_TEXT = 'Ver opciones';
const ENTRY_MENU_SECTIONS = [
  {
    title: 'Alto Rancho',
    rows: [
      { id: 'menu_order_status', title: 'Estado de pedido', description: 'Consultar en qué está tu pedido' },
      { id: 'menu_order_change', title: 'Cambios y devoluciones', description: 'Cambiar o devolver un producto' },
      { id: 'menu_stock', title: 'Stock y productos', description: 'Consultar disponibilidad' },
      { id: 'menu_talk_to_agent', title: 'Hablar con alguien', description: 'Te derivamos con el equipo' },
    ],
  },
];
const WEB_LOCAL_PROMPT = '¿Fue una compra por la web o en uno de nuestros locales?';
const WEB_LOCAL_BUTTONS = [
  { id: 'web', title: 'Por la web' },
  { id: 'local', title: 'En un local' },
];
const ORDER_TOPIC_FOLLOWUP = {
  order_status: 'Dale, pasame el número de tu pedido (o el comprobante si fue en un local) para chequear el estado.',
  order_change: 'Perfecto, pasame el número de tu pedido (o el comprobante si fue en un local) para gestionar el cambio.',
};
const STOCK_MENU_PROMPT = '¿Qué producto o SKU estás buscando?';
const TALK_TO_AGENT_PROMPT = '¿Con qué equipo querés hablar?';

function buildDepartmentSections(departments) {
  return [{
    title: 'Equipo Alto Rancho',
    rows: departments.map(d => ({ id: `dept_${d.id}`, title: d.name.slice(0, 24) })),
  }];
}

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
  // Busca [CERRAR] en cualquier posición (no solo al principio) y sin
  // importar mayúsculas/minúsculas — si el modelo no lo pone exactamente
  // al inicio, antes quedaba como texto literal visible para el cliente.
  if (/\[CERRAR\]/i.test(text)) {
    return { shouldClose: true, cleanText: text.replace(/\[CERRAR\]\s*/i, '').trim() };
  }
  return { shouldClose: false, cleanText: text };
}

function parseLabelMarkers(text) {
  const labels = [...text.matchAll(/\[LABEL:([^\]]+)\]/gi)].map(m => m[1].trim());
  const newLabels = [...text.matchAll(/\[NEW_LABEL:([^\]]+)\]/gi)].map(m => m[1].trim());
  const cleanText = text.replace(/\[(NEW_)?LABEL:[^\]]+\]/gi, '').trim();
  return { labels, newLabels, cleanText };
}

async function sendEntryMenu(to) {
  try {
    const sent = await sendWhatsAppInteractiveList(to, ENTRY_MENU_BODY, ENTRY_MENU_BUTTON_TEXT, ENTRY_MENU_SECTIONS);
    return !!sent;
  } catch (err) {
    console.error('[bot] Error enviando menú de entrada:', err.message);
    return false;
  }
}

async function handleMenuInteraction({ from, channel, interactiveId, conversation, departments, botConfig }) {
  if (channel !== 'whatsapp') return false;

  if (interactiveId === 'menu_order_status' || interactiveId === 'menu_order_change') {
    const topic = interactiveId === 'menu_order_status' ? 'order_status' : 'order_change';
    await setMenuState(from, { pendingMenuTopic: topic });
    await appendMessage(from, { role: 'assistant', content: WEB_LOCAL_PROMPT });
    await sendWhatsAppInteractiveButtons(from, WEB_LOCAL_PROMPT, WEB_LOCAL_BUTTONS)
      .catch(err => console.error('[bot] Error enviando botones web/local:', err.message));
    return true;
  }

  if (interactiveId === 'web' || interactiveId === 'local') {
    const topic = conversation.pendingMenuTopic;
    const followup = ORDER_TOPIC_FOLLOWUP[topic] ?? ORDER_TOPIC_FOLLOWUP.order_status;
    await setMenuState(from, { pendingMenuTopic: null });
    await appendMessage(from, { role: 'assistant', content: followup });
    await sendWhatsAppMessage(from, followup)
      .catch(err => console.error('[bot] Error enviando prompt de pedido:', err.message));
    return true;
  }

  if (interactiveId === 'menu_stock') {
    await appendMessage(from, { role: 'assistant', content: STOCK_MENU_PROMPT });
    await sendWhatsAppMessage(from, STOCK_MENU_PROMPT)
      .catch(err => console.error('[bot] Error enviando prompt de stock:', err.message));
    return true;
  }

  if (interactiveId === 'menu_talk_to_agent') {
    await appendMessage(from, { role: 'assistant', content: TALK_TO_AGENT_PROMPT });
    await sendWhatsAppInteractiveList(from, TALK_TO_AGENT_PROMPT, 'Ver equipos', buildDepartmentSections(departments))
      .catch(err => console.error('[bot] Error enviando lista de departamentos:', err.message));
    return true;
  }

  if (interactiveId?.startsWith('dept_')) {
    const deptId = interactiveId.slice('dept_'.length);
    const dept = departments.find(d => d.id === deptId);
    const deptName = dept?.name ?? 'Atención al cliente';
    await dispatchConversation(from, { status: 'escalated', humanMode: true, assignedTo: dept?.id ?? null });
    const escalationMsg = buildEscalationMessage(deptName, botConfig);
    await appendMessage(from, { role: 'assistant', content: escalationMsg });
    await sendWhatsAppMessage(from, escalationMsg)
      .catch(err => console.error('[bot] Error enviando confirmación de escalación:', err.message));
    return true;
  }

  return false;
}

// WhatsApp suele mandar mensajes de un mismo contacto en ráfagas de a
// segundos (varias burbujas separadas). Cada una llega como un webhook HTTP
// independiente y Express los procesa en paralelo, así que sin esta cola
// dos mensajes casi simultáneos disparan dos llamadas a Claude en paralelo
// con el mismo historial de partida — cada una responde y escala por su
// cuenta, duplicando respuestas y derivaciones al equipo. Serializamos por
// contactId para que el segundo mensaje espere a que el primero termine de
// guardar su respuesta antes de arrancar.
const contactLocks = new Map();

export function processIncomingMessage(msg) {
  const contactId = msg.from;
  const previous = contactLocks.get(contactId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => processIncomingMessageInternal(msg))
    .finally(() => {
      if (contactLocks.get(contactId) === current) contactLocks.delete(contactId);
    });
  contactLocks.set(contactId, current);
  return current;
}

async function processIncomingMessageInternal(msg) {
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
      setMenuState(from, { menuShown: false, pendingMenuTopic: null }),
    ]);
    conversation.status = 'bot';
    conversation.humanMode = false;
    conversation.assignedTo = null;
    conversation.menuShown = false;
    conversation.pendingMenuTopic = null;
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

  // --- Menú guiado (flowMode === 'menu') ---
  if (channel === 'whatsapp' && botConfig.flowMode === 'menu' && !conversation.menuShown) {
    const sent = await sendEntryMenu(from);
    if (sent) {
      if (text?.trim()) {
        await appendMessage(from, { role: 'user', content: text, contactName });
      }
      await appendMessage(from, { role: 'assistant', content: ENTRY_MENU_BODY });
      await setMenuState(from, { menuShown: true });
      console.log(`[bot] Menú de entrada enviado a ${from}`);
      return;
    }
    // Si falla el envío, no guardamos el mensaje del usuario acá — sigue el
    // flujo normal de abajo, que lo va a guardar una sola vez.
    console.warn(`[bot] No se pudo enviar el menú de entrada a ${from} — sigue el flujo normal`);
  }

  // --- Respuestas del menú guiado (botones/listas) ---
  if (type === 'interactive') {
    await appendMessage(from, { role: 'user', content: text || '(selección de menú)', contactName });
    const handled = await handleMenuInteraction({ from, channel, interactiveId: msg.interactiveId, conversation, departments, botConfig });
    if (!handled) {
      console.warn(`[bot] interactiveId no reconocido para ${from}: ${msg.interactiveId}`);
      const fallbackMsg = 'Perdón, no reconocí esa opción. ¿Podés contarme en tus propias palabras en qué te ayudo?';
      await appendMessage(from, { role: 'assistant', content: fallbackMsg });
      await sendWhatsAppMessage(from, fallbackMsg).catch(() => {});
    }
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
    resolveOrderContext(text ?? '', customer, conversation, from),
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
  let botReply;
  try {
    botReply = await generateBotResponse(text ?? '', history, {
      knowledgeBase,
      orderInfo: orderContext.orderInfo,
      orderRef: orderContext.orderRef,
      stockInfo,
      customerContext,
      availableLabels: availableLabels.map(l => l.name),
      botConfig,
      imageData,
      departments,
      isReopened: isRecent && history.length > 0,
    });
  } catch (err) {
    console.error(`[bot] Claude falló definitivamente para ${from} tras reintentos:`, err.message);
    const fallbackMsg = 'Estamos con un poquito de demora en este momento, ¡ya te contestamos! 🙏';
    await appendMessage(from, { role: 'assistant', content: fallbackMsg });
    await setUrgentFlag(from, true).catch(() => {});
    if (channel === 'whatsapp') await sendWhatsAppMessage(from, fallbackMsg).catch(() => {});
    else if (channel === 'instagram') await sendInstagramMessage(from, fallbackMsg).catch(() => {});
    return;
  }
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
  if (!text) return null;

  // El cliente pasó directamente un SKU (típico cuando el bot ya preguntó
  // "¿qué producto?" y responde solo con el código) → consultar Odoo directo,
  // sin depender de las palabras clave de STOCK_PATTERNS ni de la búsqueda
  // por nombre en TiendaNube.
  const skuMatch = text.match(SKU_PATTERN);
  if (skuMatch) {
    try {
      const sku = skuMatch[0].toUpperCase();
      const stockResult = await getStockBySku(sku);
      console.log(`[bot] stock para SKU ${sku} (detectado directo):`, stockResult);
      return formatStockInfo(sku, sku, stockResult);
    } catch (err) {
      console.error('[bot] resolveStockContext (SKU directo) error:', err.message);
      return null;
    }
  }

  if (!STOCK_PATTERNS.some(re => re.test(text))) return null;

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

async function resolveOrderContext(text, customer, conversation = {}, from = null) {
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

  // Mensaje es directamente el número (con o sin "#"), ej: bot preguntó
  // "¿número de pedido?" y el cliente contesta solo "20610" o "#20610".
  const bareMatch = trimmed.match(ORDER_BARE_NUMBER);

  // Palabra clave de pedido en cualquier parte del mensaje + número en
  // cualquier parte del mensaje (no hace falta que estén pegados).
  const hasKeyword = ORDER_KEYWORD.test(trimmed);
  const tokenMatch = trimmed.match(ORDER_REF_TOKEN);

  const orderRef = bareMatch?.[1] ?? (hasKeyword && tokenMatch ? tokenMatch[1] : null);

  if (orderRef) {
    const result = await searchOrderByRef(orderRef, customer?.tnEmail);
    return { ...result, orderRef };
  }

  // Hay intención de consultar un pedido/compra pero sin número
  const hasIntentWithoutNumber = hasKeyword || ORDER_INTENT_NO_NUMBER_PATTERNS.some(re => re.test(trimmed));
  if (hasIntentWithoutNumber) {
    // Sin número → priorizar la última orden mencionada en esta conversación,
    // luego la del perfil del cliente
    const fallbackRef = conversation.lastOrderRef ?? String(customer?.tnOrders?.[0]?.number ?? '');
    if (fallbackRef) {
      console.log(`[bot] Sin número en mensaje, usando orden del contexto: #${fallbackRef}`);
      const result = await searchOrderByRef(fallbackRef, customer?.tnEmail);
      return { ...result, orderRef: fallbackRef };
    }

    // Tampoco hay referencia previa: puede ser una compra de local físico,
    // que no queda registrada en TiendaNube. Buscar en Odoo por el teléfono
    // del cliente (ya lo tenemos, es el número de WhatsApp) antes de rendirse.
    if (from) {
      const odooOrders = await findOdooOrdersByContact(from);
      if (odooOrders.length) {
        console.log(`[bot] Pedido de local encontrado en Odoo por teléfono para ${from}`);
        const summary = odooOrders.map(o => formatOdooOrder(o)).filter(Boolean);
        return { orderInfo: summary, tnCustomer: null };
      }
    }

    return { orderInfo: null, tnCustomer: null };
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
async function searchOrderByRef(orderRef, email = null) {
  const isPureNumber = /^\d+$/.test(orderRef);
  const isOdooLocal  = /^S\d+$/i.test(orderRef);
  const isOdooTN     = /^TN\d+$/i.test(orderRef);

  // --- Número puro: pedido web, se busca ÚNICA Y EXCLUSIVAMENTE en TiendaNube.
  // Los pedidos de local usan referencia con prefijo "S" (ver más abajo) y
  // pasan por Odoo; un número puro siempre es un pedido web, así que nunca
  // hace falta (ni conviene) consultar Odoo acá.
  if (isPureNumber) {
    const tnOrder = await findOrder(orderRef);

    if (tnOrder) {
      console.log(`[bot] Pedido #${orderRef} encontrado en TiendaNube (TN id: ${tnOrder.id})`);
      return { orderInfo: formatOrderStatus(tnOrder), tnCustomer: tnOrder.customer ?? null };
    }

    // Último recurso: si ya sabemos el email del cliente en esta conversación
    // (por ejemplo lo dio en un mensaje anterior), reintentar por email.
    // Cubre pedidos 'open' que q= no indexa y que la paginación por número
    // puede fallar en encontrar bajo tráfico alto (rate limiting de TiendaNube).
    if (email) {
      console.log(`[bot] Pedido #${orderRef} no encontrado, reintentando por email conocido (${email})`);
      const emailOrders = await findOrdersByEmail(email);
      const match = emailOrders.find(o => String(o.number) === orderRef);
      if (match) {
        console.log(`[bot] Pedido #${orderRef} encontrado vía email conocido`);
        return { orderInfo: formatOrderStatus(match), tnCustomer: match.customer ?? null };
      }
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
