// Reenviar mensajes a otras conversaciones (como "Reenviar" de WhatsApp).
// El origen puede ser cualquier canal (WhatsApp o Instagram); los destinos
// son solo WhatsApp y con la ventana de 24 h abierta — fuera de la ventana
// Meta solo acepta plantillas.
import { toDate } from './statsAggregate.js';

export const FORWARD_MAX_TARGETS = 10;
export const FORWARD_MAX_MESSAGES = 30;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Decide a qué destinos se puede reenviar.
 * `conversationsById`: objeto o Map { contactId → datos de la conversación }.
 * Reasons: 'too_many' (pasa el tope), 'not_found', 'instagram', 'channel'
 * (otro canal que no es WhatsApp), 'window_closed'.
 */
export function forwardTargetsAllowed(targets = [], conversationsById = {}, now = new Date()) {
  const get = id => (conversationsById instanceof Map ? conversationsById.get(id) : conversationsById?.[id]);
  const ids = [...new Set((Array.isArray(targets) ? targets : []).filter(t => typeof t === 'string' && t))];
  const allowed = [];
  const rejected = [];
  ids.forEach((id, i) => {
    if (i >= FORWARD_MAX_TARGETS) return rejected.push({ id, reason: 'too_many' });
    const conv = get(id);
    if (!conv) return rejected.push({ id, reason: 'not_found' });
    if (conv.channel === 'instagram') return rejected.push({ id, reason: 'instagram' });
    if (conv.channel !== 'whatsapp') return rejected.push({ id, reason: 'channel' });
    const last = toDate(conv.lastClientMessageAt);
    if (!last || now.getTime() - last.getTime() > WINDOW_MS) return rejected.push({ id, reason: 'window_closed' });
    allowed.push(id);
  });
  return { allowed, rejected };
}

// "[Imagen] hola" / "[Archivo: x.pdf] mirá esto" → "hola" / "mirá esto"
export function captionFromContent(content) {
  const m = /^\[[^\]]*\]\s*([\s\S]*)$/.exec(content ?? '');
  return m ? m[1].trim() : String(content ?? '').trim();
}
