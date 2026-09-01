import https from 'https';
import { getDb } from './firebase.service.js';

const MODEL = 'claude-sonnet-5';
const PRICING = { inputPerMTok: 2.00, outputPerMTok: 10.00 };

function logUsage(usage, type) {
  if (!usage?.input_tokens) return;
  const costUSD =
    (usage.input_tokens / 1e6) * PRICING.inputPerMTok +
    (usage.output_tokens / 1e6) * PRICING.outputPerMTok;
  getDb().collection('bot-altorancho_usage_logs').add({
    service: 'claude',
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    costUSD: Math.round(costUSD * 1e6) / 1e6,
    type,
    createdAt: new Date(),
  }).catch(err => console.error('[claude] Error logging usage to Firestore:', err.message));
}

function buildEscalationInstructions(departments = []) {
  if (!departments.length) {
    return `
IMPORTANTE — ESCALADA: Si la consulta requiere atención humana y no podés resolverla, usá el marcador [ESCALAR] en una línea separada.

IMPORTANTE — CIERRE: Si la consulta está completamente resuelta, empezá tu respuesta con [CERRAR].
Ejemplo: "[CERRAR] ¡Con mucho gusto! Si necesitás algo más, escribinos cuando quieras."`;
  }

  const lines = departments.map(d => `- [ESCALAR_${d.id.toUpperCase()}] — ${d.description}`).join('\n');

  return `
IMPORTANTE — ESCALADA: Cuando la consulta requiere atención humana, usá UNO de estos marcadores en una línea separada (NUNCA pongas otro texto en esa misma línea):
${lines}

REGLA CRÍTICA: Cuando no sabés a qué departamento específico derivar, usá SIEMPRE [ESCALAR_ATENCION] — jamás dejes la consulta sin departamento asignado. [ESCALAR_ATENCION] es el equipo de atención general y el punto de entrada para cualquier situación que no encaje en otro departamento.

El texto de tu respuesta (antes o después del marcador) es lo que le llega al cliente — avisale que lo derivás y que puede haber una pequeña demora. El marcador es invisible para el cliente.
Ejemplo correcto:
"Entiendo, te paso con el equipo de logística ahora mismo. Puede tardar unos minutos, ¡pero te van a ayudar enseguida!
[ESCALAR_LOGISTICA]"

Ejemplo para casos generales o dudosos:
"Perfecto, te paso con nuestro equipo de atención al cliente para que puedan ayudarte mejor.
[ESCALAR_ATENCION]"

IMPORTANTE — CIERRE: Si la consulta está completamente resuelta y el cliente se despidió, empezá tu respuesta con [CERRAR].
Ejemplo: "[CERRAR] ¡Con mucho gusto! Si necesitás algo más, escribinos cuando quieras."
Usá [CERRAR] solo cuando estés seguro de que la conversación terminó.`;
}

// Extrae el texto de la respuesta recorriendo los bloques de `content` en
// vez de asumir que el bloque [0] es siempre de tipo texto — con modelos
// que pueden anteponer bloques de otro tipo (ej: thinking), asumir [0]
// devolvía undefined y tiraba el bot entero abajo sin avisarle nada al
// cliente (ver incidente 2026-09-01, cambio a claude-sonnet-5).
function extractText(response) {
  return (response.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}

function callAnthropicAPIOnce(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        // Concatenar los Buffers crudos y decodificar UTF-8 una sola vez al
        // final — decodificar chunk por chunk (ej: `data += chunk`) rompe
        // caracteres multi-byte (tildes, ñ) cuando quedan divididos justo en
        // el límite entre dos chunks TCP, produciendo "�" en el texto.
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          const err = new Error(`Anthropic API ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          err.retryAfter = res.headers['retry-after'];
          return reject(err);
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Anthropic response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const CLAUDE_MAX_RETRIES = 5;

/**
 * La API de Anthropic puede devolver 429 (rate limit) o 529 (overloaded)
 * bajo tráfico alto. Sin reintento, esos errores dejaban al cliente sin
 * ninguna respuesta. El tiempo no es crítico acá — lo que importa es que
 * eventualmente se genere una respuesta.
 */
async function callAnthropicAPI(payload) {
  let lastErr;
  for (let attempt = 1; attempt <= CLAUDE_MAX_RETRIES; attempt++) {
    try {
      return await callAnthropicAPIOnce(payload);
    } catch (err) {
      lastErr = err;
      const retryable = !err.statusCode || err.statusCode === 429 || err.statusCode === 529 || err.statusCode >= 500;
      if (!retryable || attempt === CLAUDE_MAX_RETRIES) throw err;
      const waitMs = err.retryAfter ? parseInt(err.retryAfter, 10) * 1000 : Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.warn(`[claude] Retry ${attempt}/${CLAUDE_MAX_RETRIES} tras error: ${err.message} — esperando ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

export async function generateConversationSummary(messages) {
  if (!messages?.length) return 'Sin mensajes para resumir.';
  const formatted = messages
    .map(m => {
      const who = m.role === 'user' ? 'Cliente' : m.role === 'admin' ? 'Agente' : 'Alto (bot)';
      return `${who}: ${m.content ?? ''}`;
    })
    .join('\n');

  const response = await callAnthropicAPI({
    model: MODEL,
    max_tokens: 350,
    system: 'Generás resúmenes breves de conversaciones de atención al cliente en español rioplatense. Respondés SOLO con el resumen, sin encabezados ni listas.',
    messages: [{
      role: 'user',
      content: `Generá un resumen de 2 a 4 oraciones de esta conversación. Incluí: el motivo principal de la consulta y cómo terminó (resuelto, derivado a agente, pendiente).\n\nConversación:\n${formatted}`,
    }],
  });
  logUsage(response.usage, 'summary');
  return extractText(response);
}

export async function generateBotResponse(userMessage, conversationHistory, context = {}) {
  const { knowledgeBase = '', orderInfo = null, orderRef = null, stockInfo = null, productInfo = null, customerContext = null, availableLabels = [], botConfig = {}, imageData = null, departments = [] } = context;

  const systemContent = buildSystemPrompt(botConfig, knowledgeBase, orderInfo, orderRef, stockInfo, productInfo, customerContext, availableLabels, departments);
  const messages = buildMessages(conversationHistory, userMessage, imageData);

  const response = await callAnthropicAPI({
    model: MODEL,
    max_tokens: 1024,
    system: systemContent,
    messages,
  });

  logUsage(response.usage, 'bot_reply');
  return extractText(response);
}

function buildSystemPrompt(botConfig = {}, knowledgeBase, orderInfo, orderRef, stockInfo, productInfo, customerContext, availableLabels = [], departments = []) {
  const botName = botConfig.botName || 'Asistente';
  const businessName = botConfig.businessName || 'Alto Rancho';
  const personality = botConfig.botPersonality ||
    `Respondés de forma amigable, natural y cercana — como lo haría una persona real del equipo.
Usás un tono cálido y profesional. Nunca robótico ni genérico.
Escribís en español rioplatense (vos, etc.) con claridad.
Si no sabés algo, lo decís honestamente y ofrecés derivar a la persona correcta.
Nunca inventás información sobre precios, stock, pedidos, políticas, procesos o links — solo usás los datos que te den. Si algo no está en la información que tenés, lo decís honestamente en vez de inventar o suponer.
Cuando tenés información de un pedido, la compartís directamente sin pedir verificación de identidad. El número de pedido es suficiente para dar información.
Si el nombre del titular del pedido es distinto al nombre de la persona que te escribe, IGUAL compartís la información con normalidad — puede ser un regalo, una compra para otra persona, o simplemente puso otro nombre al comprar. Nunca niegues ni condiciones la información de un pedido a que el nombre coincida.`;

  let prompt = `Sos el asistente virtual de ${businessName}. Tu nombre es ${botName}.\n${personality}`;
  prompt += buildEscalationInstructions(departments);
  if (knowledgeBase) {
    prompt += `\n\n--- INFORMACIÓN DE LA TIENDA ---\n${knowledgeBase}`;
    prompt += `\n\nIMPORTANTE — USO DE LA INFORMACIÓN DE LA TIENDA: Es TU ÚNICA fuente de verdad para políticas, procesos, links y datos de la tienda. Antes de responder CUALQUIER consulta, revisá esta sección completa primero. Si algo aplica, compartilo directamente aunque el cliente no lo pida explícitamente (ej: si dice que quiere hacer un cambio, pasale el link/proceso de cambios de esta sección sin que lo pida). Si la consulta no está cubierta acá, NUNCA inventes ni supongas una respuesta — decí que no tenés esa info y ofrecé derivar a alguien del equipo.`;
  }
  if (customerContext) prompt += `\n\n--- PERFIL DEL CLIENTE ---\n${customerContext}`;
  prompt += `\n\nREGLA CRÍTICA SOBRE PEDIDOS: NUNCA inventes, sugieras ni adivines números de pedido alternativos, fechas, productos o clientes. Toda la información de pedidos que compartís tiene que venir EXCLUSIVAMENTE de la sección "INFORMACIÓN DEL PEDIDO CONSULTADO" de este prompt — si esa sección no está presente, es porque no hay datos reales, y ahí no podés afirmar ni sugerir que encontraste un pedido, aunque el número se parezca a algo mencionado antes en la conversación. Si el cliente menciona una compra y no tenés información del pedido, seguí este orden: (1) Preguntale si fue un pedido de la tienda online (web) o de uno de nuestros locales físicos (Belgrano, Las Lomas, Alcorta). (2) Si fue de un LOCAL, las compras en local TAMBIÉN tienen número de comprobante/ticket (suele empezar con "S", ej: S08121) — pedile ese número y buscalo, exactamente igual que harías con un número de pedido web. (3) Si no tiene el número a mano o sigue sin encontrarse después de buscarlo, ahí sí pedí el email con el que compró. No sugieras que "quizás es otro número". No vayas directo al email — primero siempre preguntá si fue web o local, y si es local pedí el número de comprobante antes de pedir el email.`;
  if (orderInfo) {
    prompt += `\n\n--- INFORMACIÓN DEL PEDIDO CONSULTADO ---\n${JSON.stringify(orderInfo, null, 2)}`;
    prompt += `\n\nEsta información se acaba de consultar en este mismo turno y es la más actualizada que existe. Si en mensajes anteriores de esta conversación dijiste que no encontrabas el pedido, ESO YA NO APLICA — ahora sí lo tenés, usalo con normalidad sin mencionar la búsqueda anterior.`;
    prompt += `\n\nGuía para interpretar el pedido:
- tipo "WEB" → pedido de e-commerce (TiendaNube u otro canal web). Puede tener número de seguimiento.
- tipo "LOCAL" → pedido hecho en el local físico. El campo "local" indica la sucursal (Belgrano, Las Lomas, Alcorta, Rolón Local, etc.).
- Pedidos web con "tipoEntrega": "retiro en local" son RETIRO, no envío — NUNCA les hables de tracking, courier ni "está en camino". El campo "sucursalRetiro" indica en qué local retirar. Interpretá "envio" así en este caso:
  - "pendiente de preparación" → todavía se está preparando, avisale que espere la confirmación antes de ir al local.
  - "preparado / listo" → YA ESTÁ LISTO PARA RETIRAR en esa sucursal, decíselo con claridad.
  - "entregado" → ya fue retirado.
- Pedidos con "tipoEntrega": "envío a domicilio" (o pedidos LOCAL, que van por Odoo):
  - pago "pagado" + envio "enviado" → en camino, compartí el tracking si hay.
  - pago "pagado" + envio "en preparación" o "pendiente de preparación" → se está preparando, próximamente se envía.
  - pago "pagado" + envio "entregado" → ya fue entregado.
- pago "pendiente de pago" → falta confirmar el pago.
- estado "cancelado" → pedido cancelado, derivar si preguntan por reembolso.
- Si hay tracking, siempre compartilo directamente sin que el cliente lo pida (nunca aplica a un retiro en local).
- Si hay nota en el pedido, tenerla en cuenta para dar contexto.
- El método de envío puede ser Andreani u otro — no lo inventes si no está en los datos.`;
  } else if (orderRef) {
    prompt += `\n\n--- BÚSQUEDA DE PEDIDO "#${orderRef}" ---\nSe intentó buscar este pedido en TiendaNube y Odoo AHORA MISMO y NO se encontró ningún resultado. No existe. No inventes un número, fecha, cliente o producto alternativo por más que "te suene" a algo — decile honestamente al cliente que no lo encontraste. Preguntale si la compra fue por la web o en un local:
- Si es por la web, pedile que confirme bien el número de pedido (o el email de la compra como alternativa).
- Si es en un local, preguntale CUÁL (Belgrano, Las Lomas o Alcorta) y pedile el número de comprobante — nunca le digas que el número "empieza con S" ni ninguna otra regla de formato, los comprobantes de local no siguen ese patrón.
- Como último recurso, pedile el email para buscar por ahí.`;
  }
  if (stockInfo) {
    prompt += `\n\n--- STOCK EN SUCURSALES ---\n${stockInfo}`;
    prompt += `\n\nGuía para interpretar la disponibilidad:
- "Disponible" → hay stock suficiente en ese local.
- "Quedan pocos" → hay unidades pero puede agotarse pronto. Avisale al cliente que el stock puede variar y que conviene confirmar antes de ir.
- "No disponible" → sin stock en ese local al momento de la consulta.
- Nunca menciones cantidades numéricas — solo usás las etiquetas anteriores.
- Siempre agregá el disclaimer: "El stock puede variar por las ventas del local."

Si el producto es de EXHIBICIÓN (aparece "Producto de exhibición" en los datos):
- "Exhibido" → el cliente puede ir a verlo al local.
- "No exhibido" → no está en exposición en ese local.
- Aclarále que los productos de exhibición se pueden ver en el local pero la compra es solo online.

IMPORTANTE — Local Alcorta:
- Alcorta NO es un local tradicional: es un stand de iluminación (Light Studio) dentro de un shopping.
- Se puede comprar cualquier producto con disponibilidad en Alcorta, pero NO se puede ver ni probar en persona (a menos que sea un producto de iluminación o esté exhibido).
- Cuando haya disponibilidad en Alcorta para un producto no relacionado con iluminación, avisale al cliente que puede comprarlo allí pero que no va a poder verlo en persona.`;
  }
  if (productInfo) {
    prompt += `\n\n--- FICHA DEL PRODUCTO ---\n${productInfo}`;
    prompt += `\n\nUsá esta ficha para responder preguntas sobre material, medidas, armado o cuidados del producto. Si la descripción no cubre lo que te preguntan, decilo honestamente en vez de inventar — no asumas materiales, medidas ni instrucciones que no estén acá.`;
  }
  if (availableLabels.length) {
    prompt += `\n\n--- ETIQUETAS ---\nDEBÉS etiquetar SIEMPRE esta conversación con al menos 1 etiqueta usando [LABEL:nombre] en tu respuesta (invisible para el cliente).
Etiquetas disponibles: ${availableLabels.join(', ')}.
Si ninguna aplica, creá una nueva con [NEW_LABEL:nombre] (ej: [NEW_LABEL:Mayorista]).
Guía:
- [LABEL:Consulta] → preguntas generales sobre productos, tallas, disponibilidad.
- [LABEL:Pedido] → consulta sobre un pedido específico.
- [LABEL:Reclamo] → queja, problema o insatisfacción.
- [LABEL:Devolución] → cambio, devolución o reembolso.
Podés combinar varias etiquetas si aplica.`;
  }
  return prompt;
}

function buildMessages(conversationHistory, newMessage, imageData = null) {
  const messages = [];
  if (conversationHistory?.length) {
    const recent = conversationHistory.slice(-10);
    for (const msg of recent) {
      const role = msg.role === 'user' ? 'user' : 'assistant';
      messages.push({ role, content: msg.content });
    }
  }
  if (imageData) {
    messages.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.base64 } },
        { type: 'text', text: newMessage || 'Describí esta imagen en el contexto de la consulta del cliente.' },
      ],
    });
  } else {
    messages.push({ role: 'user', content: newMessage });
  }
  return messages;
}
