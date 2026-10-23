// Respuestas del cliente a las notificaciones automáticas de SimpliRoute.
// Regla del negocio (2026-10-23): si solo agradece o confirma, el bot cierra
// la conversación; ante cualquier problema o pedido de cambio, deriva directo
// a Logística (no a Atención, aunque el resto de las derivaciones se fuercen
// a Atención — ver FORCE_ESCALATE_TO_ATENCION en bot.service.js).

export const SIMPLI_ESCALATE_TO = 'logistica';
export const SIMPLI_DEPT_NAME = 'Logística';
const MAX_AGE_MS = 72 * 60 * 60 * 1000;

// Nombres actuales y anteriores (las _v2 reemplazaron a las que quedaron
// trabadas en Meta) — un chat viejo puede tener cualquiera de los dos.
const TEMPLATES = {
  pedido_programado: 'su pedido está programado para entrega',
  pedido_en_camino: 'su pedido está en camino',
  pedido_en_camino_v2: 'su pedido está en camino',
  pedido_entregado: 'su pedido fue entregado',
  pedido_entregado_v2: 'su pedido fue entregado',
  pedido_no_entregado: 'no se pudo entregar su pedido',
};

const TEMPLATE_RE = /^\[Plantilla: ([\w-]+)\](?: pedido #(\S+))?/;

function toMs(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  const secs = ts._seconds ?? ts.seconds;
  if (secs != null) return secs * 1000;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Si el cliente está contestando a una notificación de SimpliRoute, devuelve
 * { templateName, orderNumber, meaning }; si no, null.
 * Cuenta la última plantilla de SimpliRoute de las últimas 72 h siempre que
 * después no haya intervenido un agente (ahí la charla ya es con una persona).
 */
export function findSimpliContext(history = [], now = Date.now()) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role !== 'admin') continue;
    const match = TEMPLATE_RE.exec(String(m.content ?? ''));
    if (!match) return null; // un agente escribió después de la plantilla
    const meaning = TEMPLATES[match[1]];
    if (!meaning) return null; // la última plantilla no es de SimpliRoute
    const sentAt = toMs(m.timestamp);
    if (sentAt != null && now - sentAt > MAX_AGE_MS) return null;
    return { templateName: match[1], orderNumber: match[2] ?? null, meaning };
  }
  return null;
}

export function buildSimpliInstructions(ctx) {
  if (!ctx) return '';
  const pedido = ctx.orderNumber ? ` (pedido #${ctx.orderNumber})` : '';
  return `\n\n--- EL CLIENTE RESPONDE A UNA NOTIFICACIÓN DE LOGÍSTICA ---
Le mandamos un aviso automático de que ${ctx.meaning}${pedido}. Lo que escribe ahora es la respuesta a ese aviso. Decidí así:
- Si solo agradece, confirma, saluda o dice que ya lo recibió/retiró, sin pedir nada (ej: "gracias", "ok", "perfecto", "genial", "dale", "ya llegó"): respondé breve y cordial y agregá [CERRAR] en una línea aparte.
- Si plantea CUALQUIER cosa que necesite que logística haga algo (cambiar día u horario, que no va a haber nadie, dejarlo en portería/seguridad o con otra persona, cambiar la dirección, que no le llegó, que llegó dañado o incompleto, que quiere coordinar, cualquier problema): decile que se lo pasás al equipo de logística, repetí en tu mensaje el dato que te dio para que quede registrado, y agregá [ESCALAR_LOGISTICA] en una línea aparte. En este caso usá SIEMPRE ese marcador, no otro.
- Si es una pregunta que podés contestar con la información que tenés (estado del pedido, datos de la tienda), contestala sin derivar.`;
}

/**
 * Detecta cualquier marcador de derivación ([ESCALAR], [ESCALAR_LOGISTICA],
 * [ESCALAR_ATENCION]…) y lo saca del texto. En contexto de SimpliRoute toda
 * derivación va a Logística, sin importar qué marcador eligió el modelo.
 */
export function parseAnyEscalation(text = '') {
  const re = /\[ESCALAR(?:_[A-Z0-9_]+)?\]/i;
  if (!re.test(text)) return { shouldEscalate: false, cleanText: text };
  // Solo se saca el marcador (no la línea entera): si el modelo lo puso al
  // final de una oración, la oración tiene que llegarle igual al cliente.
  const cleanText = text
    .replace(/[ \t]*\[ESCALAR(?:_[A-Z0-9_]+)?\][ \t]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { shouldEscalate: true, cleanText };
}
