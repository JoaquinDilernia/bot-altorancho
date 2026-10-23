// Regla única de "esperando a alguien del equipo" (la misma que usa el panel
// en client/src/lib/conversationView.js → pillFor):
//   - escalada (o status 'bot' con humanMode, caso legado), y
//     (el status legado 'urgent' cuenta como 'bot': hoy urgente es un flag aparte;
//     el canal da igual, WhatsApp e Instagram esperan por igual), y
//   - no la tomó un agente (assignedTo no es el id ni el email de un agente), y
//   - nadie del equipo respondió todavía en este ciclo de escalamiento
//     (firstAgentResponseAt se resetea en cada escalamiento).
import { toDate } from './statsAggregate.js';

/** Set de claves (id y email) que identifican a un agente. */
export function agentKeySet(agents = []) {
  const keys = new Set();
  for (const a of agents) {
    if (a?.id) keys.add(a.id);
    if (a?.email) keys.add(a.email);
  }
  return keys;
}

export function isWaiting(conv, agentKeys = new Set()) {
  if (!conv) return false;
  const rawStatus = conv.status ?? 'bot';
  const status = rawStatus === 'urgent' ? 'bot' : rawStatus;
  const escalated = status === 'escalated' || (status === 'bot' && conv.humanMode === true);
  if (!escalated) return false;
  if (conv.assignedTo && agentKeys.has(conv.assignedTo)) return false;
  if (conv.firstAgentResponseAt) return false;
  return true;
}

/**
 * ¿El agente ve esta conversación en el panel? Misma regla que GET
 * /api/conversations: un operador solo ve las asignadas a su departamento o a
 * su email; admin / atencion_cliente ven todas.
 */
export function visibleTo(conv, agent) {
  if (!conv) return false;
  if (agent?.role !== 'operador') return true;
  const targets = [agent.department, agent.email].filter(Boolean);
  return targets.includes(conv.assignedTo);
}

/** Las que esperan y el agente puede ver (operador: solo su depto/email). */
export function waitingVisibleTo(conversations = [], agents = [], agent) {
  const keys = agentKeySet(agents);
  return conversations.filter(c => isWaiting(c, keys) && visibleTo(c, agent));
}

/** Une listas de conversaciones sin repetir el mismo id (la primera gana). */
export function mergeById(...lists) {
  const byId = new Map();
  for (const list of lists) for (const c of list ?? []) if (c?.id && !byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()];
}

/** Cuántas esperan y hace cuántos minutos (enteros) espera la más vieja. */
export function waitingSummary(conversations = [], agents = [], now = new Date()) {
  const keys = agentKeySet(agents);
  const waiting = conversations.filter(c => isWaiting(c, keys));
  if (!waiting.length) return { count: 0, oldestMin: null };
  const nowMs = now.getTime();
  const mins = waiting.map(c => {
    const since = toDate(c.waitingSince) ?? toDate(c.escalatedAt);
    return since ? Math.max(0, Math.floor((nowMs - since.getTime()) / 60000)) : 0;
  });
  return { count: waiting.length, oldestMin: Math.max(...mins) };
}
