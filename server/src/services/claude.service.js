import https from 'https';
import { getDb } from './firebase.service.js';

const MODEL = 'claude-sonnet-5';
// Caché de prompt: escribir cuesta 1.25x la entrada (TTL 5 min), leer 0.1x.
const PRICING = { inputPerMTok: 2.00, outputPerMTok: 10.00, cacheWritePerMTok: 2.50, cacheReadPerMTok: 0.20 };

function logUsage(usage, type) {
  if (!usage?.input_tokens && !usage?.cache_read_input_tokens) return;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const costUSD =
    (usage.input_tokens / 1e6) * PRICING.inputPerMTok +
    (cacheWrite / 1e6) * PRICING.cacheWritePerMTok +
    (cacheRead / 1e6) * PRICING.cacheReadPerMTok +
    (usage.output_tokens / 1e6) * PRICING.outputPerMTok;
  getDb().collection('bot-altorancho_usage_logs').add({
    service: 'claude',
    model: MODEL,
    inputTokens: usage.input_tokens, // sólo la parte NO cacheada
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
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
  const { knowledgeBase = '', orderInfo = null, orderRef = null, stockInfo = null, productInfo = null, customerContext = null, availableLabels = [], customerTags = [], botConfig = {}, imageData = null, departments = [], tools = [], runTool = null, extraInstructions = '' } = context;

  const systemContent = buildSystemPrompt(botConfig, knowledgeBase, orderInfo, orderRef, stockInfo, productInfo, customerContext, availableLabels, departments, customerTags, tools.length > 0);
  // Instrucciones por mensaje (ej: respuesta a una notificación de
  // SimpliRoute) — van al bloque variable para no romper el caché.
  if (extraInstructions) systemContent[1].text += extraInstructions;
  const messages = buildMessages(conversationHistory, userMessage, imageData);

  // Loop de tool-use (mismo patrón que ENTRENO/Selvaggio): mientras Claude
  // pida tools, se ejecutan y se le devuelven los resultados. El turno del
  // asistente se reenvía con su `content` COMPLETO y todos los tool_result
  // van juntos en un único mensaje de usuario.
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callAnthropicAPI({
      model: MODEL,
      max_tokens: 1024,
      system: systemContent,
      messages,
      ...(tools.length && { tools }),
    });
    logUsage(response.usage, round === 0 ? 'bot_reply' : 'bot_reply_tool');

    if (response.stop_reason !== 'tool_use' || !runTool) return extractText(response);

    const calls = response.content.filter(b => b.type === 'tool_use');
    const results = await Promise.all(calls.map(async (call) => {
      let output;
      try {
        output = await runTool(call.name, call.input ?? {});
      } catch (err) {
        output = { error: err.message };
      }
      console.log(`[claude] tool ${call.name}`, JSON.stringify(call.input), '→', JSON.stringify(output).slice(0, 300));
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(output),
        ...(output?.error && { is_error: true }),
      };
    }));
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: results });
  }

  console.warn('[claude] Se alcanzó el máximo de rondas de tools sin respuesta final');
  return 'Perdón, se me complicó revisar eso. ¿Me lo repetís o preferís que te pase con alguien del equipo?';
}

const MAX_TOOL_ROUNDS = 4;

// Sin la fecha, el modelo no sabe qué día es: un aviso de la KB como "el
// lunes 28/9 los locales están cerrados" no lo puede cruzar con un "¿hoy
// abren?" del cliente, y termina contestando "sí, hoy sábado abrimos".
function buildCurrentDateInstructions() {
  const now = new Date();
  const tz = 'America/Argentina/Buenos_Aires';
  const fecha = now.toLocaleDateString('es-AR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
  const hora = now.toLocaleTimeString('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  return `\n\n--- FECHA Y HORA ACTUAL ---\nHoy es ${fecha}, son las ${hora} (hora de Argentina). Usá esto para interpretar "hoy", "mañana", "el finde", etc. — nunca supongas otro día. Si la información de la tienda tiene un aviso con fecha (feriados, cierres, horarios especiales) que cae hoy o en el día que menciona el cliente, avisalo SIEMPRE cuando el cliente hable de ir, pasar o retirar en un local, o pregunte si están abiertos — antes de pasarle los horarios habituales.`;
}

function buildSystemPrompt(botConfig = {}, knowledgeBase, orderInfo, orderRef, stockInfo, productInfo, customerContext, availableLabels = [], departments = [], customerTags = [], hasProductTools = false) {
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

  // El system va en 2 bloques para aprovechar el caché de prompt (los tokens
  // cacheados se cobran ~10%): primero todo lo que es IGUAL para todos los
  // clientes (personalidad, KB, reglas, etiquetas, tags) con cache_control,
  // y después lo que cambia en cada mensaje (fecha/hora, perfil, pedido,
  // stock, ficha). Cualquier dato variable dentro del primer bloque rompe el
  // caché para todos — no meter ahí nada que dependa del cliente o la hora.
  let prompt = `Sos el asistente virtual de ${businessName}. Tu nombre es ${botName}.\n${personality}`;
  prompt += buildEscalationInstructions(departments);
  if (knowledgeBase) {
    prompt += `\n\n--- INFORMACIÓN DE LA TIENDA ---\n${knowledgeBase}`;
    prompt += `\n\nIMPORTANTE — USO DE LA INFORMACIÓN DE LA TIENDA: Es TU ÚNICA fuente de verdad para políticas, procesos, links y datos de la tienda. Antes de responder CUALQUIER consulta, revisá esta sección completa primero. Si algo aplica, compartilo directamente aunque el cliente no lo pida explícitamente (ej: si dice que quiere hacer un cambio, pasale el link/proceso de cambios de esta sección sin que lo pida). Si la consulta no está cubierta acá, NUNCA inventes ni supongas una respuesta — decí que no tenés esa info y ofrecé derivar a alguien del equipo.
Los items marcados con 🔥 son promociones u ofertas vigentes que queremos impulsar activamente: mencionalas cuando el cliente hable de productos, precios, o esté evaluando una compra, aunque no pregunte por la promo puntualmente. No hace falta que el tema calce exacto — la idea es aprovechar la oportunidad de venta. Eso sí, no la repitas en cada mensaje: si ya la mencionaste en esta conversación, no la vuelvas a meter salvo que el cliente pregunte de nuevo por ella.`;
  }
  prompt += `\n\nREGLA CRÍTICA SOBRE PEDIDOS: NUNCA inventes, sugieras ni adivines números de pedido alternativos, fechas, productos o clientes. Toda la información de pedidos que compartís tiene que venir EXCLUSIVAMENTE de la sección "INFORMACIÓN DEL PEDIDO CONSULTADO" de este prompt — si esa sección no está presente, es porque no hay datos reales, y ahí no podés afirmar ni sugerir que encontraste un pedido, aunque el número se parezca a algo mencionado antes en la conversación. Si el cliente menciona una compra y no tenés información del pedido, seguí este orden: (1) Preguntale si fue un pedido de la tienda online (web) o de uno de nuestros locales físicos (Belgrano, Las Lomas, Alcorta). (2) Si fue de un LOCAL, las compras en local TAMBIÉN tienen número de comprobante/ticket (suele empezar con "S", ej: S08121) — pedile ese número y buscalo, exactamente igual que harías con un número de pedido web. (3) Si no tiene el número a mano o sigue sin encontrarse después de buscarlo, ahí sí pedí el email con el que compró. No sugieras que "quizás es otro número". No vayas directo al email — primero siempre preguntá si fue web o local, y si es local pedí el número de comprobante antes de pedir el email.`;
  if (hasProductTools) {
    prompt += `\n\n--- LINKS DE PRODUCTOS Y CARRITO (tienda online) ---
Tenés tres herramientas:
- buscar_productos: busca en la tienda online por nombre y devuelve, por producto, su ficha (descripción con material, medidas, aclaraciones), el link y la disponibilidad web por variante, con sus ids. Usala SIEMPRE antes de decir que no tenés un dato de un producto (medidas, material, colores, qué incluye, si el precio es por una unidad o por el set): la respuesta suele estar en la ficha. Armá la consulta con el contexto de toda la charla y corregí typos obvios; si no aparece, probá con menos palabras o un sinónimo antes de rendirte.
- consultar_stock_locales: disponibilidad de UN producto en los locales (Belgrano, Las Lomas de San Isidro, Alcorta) y en la web. Usala cuando pregunten si hay en un local, dónde verlo o si conviene ir — aunque en el mensaje no repitan el nombre del producto (sacalo de la charla). Interpretación: "Disponible" = hay; "Quedan pocos" = avisale que puede agotarse y que conviene confirmar antes de ir; "No disponible" = no hay en ese local; "Exhibido/No exhibido" = productos de exhibición, se ven en el local pero se compran online. Nunca digas cantidades y aclarale que el stock puede variar por las ventas del local. Alcorta es un stand de iluminación (Light Studio) en un shopping: se puede comprar ahí lo que tenga disponible, pero solo se ve en persona la iluminación o lo exhibido.
- armar_carrito: arma UN link al carrito de la web con los productos ya cargados.
Si la ficha no tiene el dato que te piden, decilo honestamente (no inventes) y recién ahí ofrecé derivar.
Reglas:
- Cuando recomendás o informás un producto puntual, pasá su "Link:" tal cual (nunca lo inventes ni lo armes vos). Si son varios, un link por producto.
- [producto_id …] y [variante_id …] son de uso interno: nunca se los muestres al cliente.
- Si el cliente quiere comprar online, pide "el link para comprar", o eligió varios productos y está de acuerdo, usá armar_carrito con TODOS juntos y mandale ese único link.
- Antes de armarlo confirmá la variante (color/medida/etc.) de cada producto que tenga más de una, y la cantidad si no es 1. Solo variantes con stock web.
- Al mandar el link del carrito: listá lo que lleva y avisale que al abrirlo ponga su código postal para calcular el envío y elegir cómo recibirlo (envío o retiro) antes de pagar.
- Si armar_carrito devuelve un error (sin stock web, etc.), contale qué pasó con ese producto y ofrecé una alternativa; no mandes un carrito incompleto sin avisar.
- Ojo: cada vez que se abre, el link SUMA sus productos a lo que ya haya en el carrito (abrirlo dos veces duplica las cantidades) y nunca saca nada. Por eso:
  - Si después quiere agregar productos, armá un carrito SOLO con lo nuevo y aclarale que se suma a lo que ya tiene.
  - Si cambia variante o cantidad, o quiere sacar algo, no mandes otro link: decile que lo ajuste en el carrito (con − / + o "Eliminar").
  - Si te dice que le aparecen cantidades de más, explicale que es porque abrió el link más de una vez y que lo corrija con − o "Eliminar".
- El carrito es solo para comprar en la web. Si quiere comprar en un local, no armes carrito.`;
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

  // --- Tags de CONTACTO (persisten entre conversaciones, sirven para segmentar
  //     difusiones). A diferencia de las etiquetas de conversación, NO son
  //     obligatorios: solo taggeás si el mensaje da una señal clara.
  {
    const guide = (botConfig.customerTagsGuide || '').trim();
    const existing = (customerTags || []).filter(Boolean);
    prompt += `\n\n--- TAGS DE CONTACTO ---
Si en el mensaje aparece una señal CLARA sobre quién es este cliente, agregale un tag con [TAG:nombre] (invisible para el cliente). NO inventes si no hay señal — es opcional.
Categorías: tipo de cliente (Mayorista/Minorista/Revendedor), rubro/interés (Iluminación, Deco, Muebles…), zona o sucursal (Belgrano, Nordelta, San Isidro, Alcorta…), comportamiento (Recurrente, Primera compra, Reclamó).`;
    if (existing.length) prompt += `\nTags que ya se usan (reusá estos si aplican, respetando cómo están escritos): ${existing.join(', ')}.`;
    prompt += `\nSi ninguno encaja y la señal es clara, creá uno con [NEW_TAG:nombre].`;
    if (guide) prompt += `\nGuía del negocio:\n${guide}`;
  }

  // ── Bloque variable (por mensaje) ──
  const stable = prompt;
  prompt = buildCurrentDateInstructions().trimStart();
  if (customerContext) prompt += `\n\n--- PERFIL DEL CLIENTE ---\n${customerContext}`;
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
    prompt += `\n\n--- STOCK (SUCURSALES Y WEB) ---\n${stockInfo}`;
    prompt += `\n\nGuía para interpretar la disponibilidad:
- "Disponible" → hay stock suficiente en ese local.
- "Quedan pocos" → hay unidades pero puede agotarse pronto. Avisale al cliente que el stock puede variar y que conviene confirmar antes de ir.
- "No disponible" → sin stock en ese local al momento de la consulta.
- Nunca menciones cantidades numéricas — solo usás las etiquetas anteriores.
- Siempre agregá el disclaimer: "El stock puede variar por las ventas del local."
- Si aparece "Disponibilidad en la tienda online (web)", es el stock para comprar por la web (TiendaNube), por variante (talle/color/etc.) — "Sin stock" significa que no se puede comprar online. Usalo cuando pregunten por la web, por envío o en general por disponibilidad; no lo confundas con el stock de los locales. Si solo viene el stock web, no inventes stock de sucursales.

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

  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: prompt },
  ];
}

function buildMessages(conversationHistory, newMessage, imageData = null) {
  const messages = [];
  if (conversationHistory?.length) {
    const recent = conversationHistory.slice(-10);
    for (const msg of recent) {
      const role = msg.role === 'user' ? 'user' : 'assistant';
      const content = msg.transcript ? `[Audio transcripto] ${msg.transcript}` : msg.content;
      messages.push({ role, content });
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
