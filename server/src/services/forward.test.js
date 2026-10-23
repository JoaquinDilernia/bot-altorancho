import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardTargetsAllowed, captionFromContent, FORWARD_MAX_TARGETS } from './forward.js';

const now = new Date('2026-10-23T12:00:00Z');
const hoursAgo = h => new Date(now.getTime() - h * 3600000);

test('destino de Instagram: rechazado con reason instagram', () => {
  const convs = { ig1: { channel: 'instagram', lastClientMessageAt: hoursAgo(1) } };
  assert.deepEqual(forwardTargetsAllowed(['ig1'], convs, now), {
    allowed: [],
    rejected: [{ id: 'ig1', reason: 'instagram' }],
  });
});

test('WhatsApp con último mensaje del cliente hace más de 24 h: window_closed', () => {
  const convs = { wa1: { channel: 'whatsapp', lastClientMessageAt: hoursAgo(25) } };
  assert.deepEqual(forwardTargetsAllowed(['wa1'], convs, now).rejected, [{ id: 'wa1', reason: 'window_closed' }]);
});

test('WhatsApp sin mensaje del cliente: window_closed', () => {
  const convs = { wa1: { channel: 'whatsapp', lastClientMessageAt: null } };
  assert.deepEqual(forwardTargetsAllowed(['wa1'], convs, now).rejected, [{ id: 'wa1', reason: 'window_closed' }]);
});

test('WhatsApp dentro de las 24 h: permitido (acepta Timestamp de Firestore)', () => {
  const ts = { toDate: () => hoursAgo(23) };
  const convs = { wa1: { channel: 'whatsapp', lastClientMessageAt: ts }, wa2: { channel: 'whatsapp', lastClientMessageAt: hoursAgo(2) } };
  assert.deepEqual(forwardTargetsAllowed(['wa1', 'wa2'], convs, now), { allowed: ['wa1', 'wa2'], rejected: [] });
});

test('acepta un Map como índice de conversaciones', () => {
  const convs = new Map([['wa1', { channel: 'whatsapp', lastClientMessageAt: hoursAgo(1) }]]);
  assert.deepEqual(forwardTargetsAllowed(['wa1'], convs, now).allowed, ['wa1']);
});

test('conversación inexistente: not_found', () => {
  assert.deepEqual(forwardTargetsAllowed(['x'], {}, now).rejected, [{ id: 'x', reason: 'not_found' }]);
});

test('máximo 10 destinos: el resto se rechaza con too_many; repetidos se ignoran', () => {
  assert.equal(FORWARD_MAX_TARGETS, 10);
  const ids = Array.from({ length: 12 }, (_, i) => `wa${i}`);
  const convs = Object.fromEntries(ids.map(id => [id, { channel: 'whatsapp', lastClientMessageAt: hoursAgo(1) }]));
  const { allowed, rejected } = forwardTargetsAllowed(['wa0', 'wa0', ...ids], convs, now);
  assert.equal(allowed.length, 10);
  assert.deepEqual(allowed, ids.slice(0, 10));
  assert.deepEqual(rejected, [{ id: 'wa10', reason: 'too_many' }, { id: 'wa11', reason: 'too_many' }]);
});

test('captionFromContent saca la etiqueta del adjunto', () => {
  assert.equal(captionFromContent('[Imagen] hola'), 'hola');
  assert.equal(captionFromContent('[Archivo: x.pdf] mirá esto'), 'mirá esto');
  assert.equal(captionFromContent('[Imagen recibida]'), '');
  assert.equal(captionFromContent('texto suelto'), 'texto suelto');
  assert.equal(captionFromContent(undefined), '');
});
