import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWaiting, agentKeySet, waitingSummary, mergeById, visibleTo, waitingVisibleTo } from './waiting.js';

const agents = [{ id: 'ag1', email: 'ana@altorancho.com' }];
const keys = agentKeySet(agents);

test('escalada sin asignar y sin respuesta: espera', () => {
  assert.equal(isWaiting({ status: 'escalated', humanMode: true, assignedTo: null }, keys), true);
});

test('derivada a un departamento (id que no es agente): espera', () => {
  assert.equal(isWaiting({ status: 'escalated', humanMode: true, assignedTo: 'dep-ventas' }, keys), true);
});

test('asignada a un agente por id o por email: no espera', () => {
  assert.equal(isWaiting({ status: 'escalated', humanMode: true, assignedTo: 'ag1' }, keys), false);
  assert.equal(isWaiting({ status: 'escalated', humanMode: true, assignedTo: 'ana@altorancho.com' }, keys), false);
});

test('derivada a departamento pero ya respondió alguien del equipo: no espera', () => {
  const conv = { status: 'escalated', humanMode: true, assignedTo: 'dep-ventas', firstAgentResponseAt: new Date() };
  assert.equal(isWaiting(conv, keys), false);
});

test('legado: status bot + humanMode cuenta como escalada', () => {
  assert.equal(isWaiting({ status: 'bot', humanMode: true }, keys), true);
  assert.equal(isWaiting({ status: 'bot', humanMode: false }, keys), false);
  assert.equal(isWaiting({ humanMode: false }, keys), false);
});

test('cerradas nunca esperan', () => {
  assert.equal(isWaiting({ status: 'resolved', humanMode: true }, keys), false);
  assert.equal(isWaiting({ status: 'bot_archived', humanMode: true }, keys), false);
});

test('waitingSummary usa waitingSince ?? escalatedAt y minutos enteros', () => {
  const now = new Date('2026-10-21T13:00:00Z');
  const convs = [
    { status: 'escalated', escalatedAt: new Date('2026-10-21T12:30:00Z') }, // 30 min
    { status: 'escalated', escalatedAt: new Date('2026-10-21T11:00:00Z'), waitingSince: new Date('2026-10-21T12:49:30Z') }, // 10 min
    { status: 'escalated', assignedTo: 'ag1', escalatedAt: new Date('2026-10-21T08:00:00Z') }, // tomada: no cuenta
    { status: 'escalated', escalatedAt: { toDate: () => new Date('2026-10-21T12:00:00Z') }, firstAgentResponseAt: new Date() }, // respondida
  ];
  assert.deepEqual(waitingSummary(convs, agents, now), { count: 2, oldestMin: 30 });
});

test('waitingSummary sin esperas devuelve 0 y null', () => {
  assert.deepEqual(waitingSummary([], agents), { count: 0, oldestMin: null });
});

test('Instagram escalada cuenta igual que WhatsApp', () => {
  assert.equal(isWaiting({ status: 'escalated', channel: 'instagram' }, new Set()), true);
});

test("legado: status 'urgent' se trata como 'bot' (espera solo con humanMode)", () => {
  assert.equal(isWaiting({ status: 'urgent', humanMode: true }, new Set()), true);
  assert.equal(isWaiting({ status: 'urgent', humanMode: false }, new Set()), false);
});

test('flag urgent no cambia la regla: tomada por un agente no espera', () => {
  assert.equal(isWaiting({ status: 'escalated', urgent: true, assignedTo: 'a1' }, new Set(['a1'])), false);
});

test('escaladas + humanMode unidas sin duplicar: el legado bot/urgent con humanMode cuenta', () => {
  const now = new Date('2026-10-21T13:00:00Z');
  const escalated = [
    { id: 'e1', status: 'escalated', humanMode: true, escalatedAt: new Date('2026-10-21T12:50:00Z') }, // 10 min
  ];
  const humanMode = [
    { id: 'e1', status: 'escalated', humanMode: true, escalatedAt: new Date('2026-10-21T12:50:00Z') }, // repetida
    { id: 'l1', status: 'bot', humanMode: true, waitingSince: new Date('2026-10-21T12:20:00Z') },   // legado, 40 min
    { id: 'l2', status: 'urgent', humanMode: true, assignedTo: 'ag1' },                              // tomada: no
  ];
  const merged = mergeById(escalated, humanMode);
  assert.deepEqual(merged.map(c => c.id), ['e1', 'l1', 'l2']);
  assert.deepEqual(waitingSummary(merged, agents, now), { count: 2, oldestMin: 40 });
});

test('visibleTo: operador ve solo lo asignado a su departamento o email', () => {
  const op = { role: 'operador', department: 'ventas', email: 'ana@x.com' };
  assert.equal(visibleTo({ id: '1', assignedTo: 'ventas' }, op), true);
  assert.equal(visibleTo({ id: '2', assignedTo: 'ana@x.com' }, op), true);
  assert.equal(visibleTo({ id: '3', assignedTo: 'logistica' }, op), false);
  assert.equal(visibleTo({ id: '4', assignedTo: null }, op), false);
  assert.equal(visibleTo({ id: '5' }, { role: 'operador', email: 'ana@x.com' }), false);
});

test('visibleTo: admin y atencion_cliente ven todo', () => {
  for (const role of ['admin', 'atencion_cliente']) {
    assert.equal(visibleTo({ id: '1', assignedTo: 'logistica' }, { role }), true);
    assert.equal(visibleTo({ id: '2', assignedTo: null }, { role }), true);
  }
});

test('contador del operador: solo cuenta las esperando de su departamento', () => {
  const op = { role: 'operador', department: 'ventas', email: 'ana@x.com' };
  const convs = [
    { id: 'a', status: 'escalated', assignedTo: 'ventas' },
    { id: 'b', status: 'escalated', assignedTo: 'logistica' },
    { id: 'c', status: 'escalated', assignedTo: null },
  ];
  assert.equal(waitingSummary(convs.filter(c => visibleTo(c, op)), []).count, 1);
  assert.equal(waitingSummary(convs.filter(c => visibleTo(c, { role: 'admin' })), []).count, 3);
});

test('waitingVisibleTo: solo esperando y visibles para el agente', () => {
  const convs = [
    { id: 'a', status: 'escalated', assignedTo: 'ventas' },                       // espera, depto ventas
    { id: 'b', status: 'escalated', assignedTo: 'logistica' },                    // espera, otro depto
    { id: 'c', status: 'escalated', assignedTo: 'ag1' },                          // tomada por agente
    { id: 'd', status: 'escalated', assignedTo: 'ventas', firstAgentResponseAt: '2026-10-20T10:00:00Z' }, // ya respondida
    { id: 'e', status: 'bot', humanMode: true, assignedTo: 'ventas' },            // legado
    { id: 'f', status: 'resolved', assignedTo: 'ventas' },                        // no espera
  ];
  const op = { role: 'operador', department: 'ventas', email: 'ana@x.com' };
  assert.deepEqual(waitingVisibleTo(convs, agents, op).map(c => c.id), ['a', 'e']);
  assert.deepEqual(waitingVisibleTo(convs, agents, { role: 'admin' }).map(c => c.id), ['a', 'b', 'e']);
});
