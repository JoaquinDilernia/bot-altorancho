import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagramMessage, isInstagramWindowError, sendInstagramAsAgent } from './meta.service.js';
import { isOwnMediaPath } from './mediaStore.js';

const igBody = (attachments, text) => ({
  entry: [{ messaging: [{ sender: { id: '123' }, timestamp: 1, message: { mid: 'm1', ...(text && { text }), attachments } }] }],
});

test('parseInstagramMessage: imagen trae su URL', () => {
  const m = parseInstagramMessage(igBody([{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }]));
  assert.equal(m.type, 'image');
  assert.equal(m.mediaUrl, 'https://cdn/x.jpg');
});

test('parseInstagramMessage: audio también trae URL (para transcribir y guardar)', () => {
  const m = parseInstagramMessage(igBody([{ type: 'audio', payload: { url: 'https://cdn/a.mp4' } }]));
  assert.equal(m.type, 'audio');
  assert.equal(m.mediaUrl, 'https://cdn/a.mp4');
});

test('parseInstagramMessage: "file" de IG → document', () => {
  const m = parseInstagramMessage(igBody([{ type: 'file', payload: { url: 'https://cdn/f.pdf' } }]));
  assert.equal(m.type, 'document');
});

test('parseInstagramMessage: texto sin adjuntos sigue siendo text', () => {
  const m = parseInstagramMessage(igBody([], 'hola'));
  assert.equal(m.type, 'text');
  assert.equal(m.mediaUrl, null);
});

const igErr = (error) => Object.assign(new Error('meta'), { response: { data: { error } } });

test('isInstagramWindowError: subcode 2534022 o mensaje de ventana', () => {
  assert.equal(isInstagramWindowError(igErr({ code: 10, error_subcode: 2534022 })), true);
  assert.equal(isInstagramWindowError(igErr({ code: 10, message: 'This message is sent outside of allowed window.' })), true);
  assert.equal(isInstagramWindowError(igErr({ code: 100, message: 'Invalid parameter' })), false);
});

test('sendInstagramAsAgent: si la ventana venció reintenta con HUMAN_AGENT', async () => {
  const calls = [];
  const r = await sendInstagramAsAgent(async (opts) => {
    calls.push(opts.humanAgent);
    if (!opts.humanAgent) throw igErr({ code: 10, error_subcode: 2534022 });
    return 'mid-ok';
  });
  assert.deepEqual(calls, [false, true]);
  assert.equal(r, 'mid-ok');
});

test('sendInstagramAsAgent: otros errores no reintentan', async () => {
  const calls = [];
  await assert.rejects(sendInstagramAsAgent(async (opts) => {
    calls.push(opts.humanAgent);
    throw igErr({ code: 100, message: 'Invalid parameter' });
  }));
  assert.deepEqual(calls, [false]);
});

test('isOwnMediaPath: solo rutas del bot, sin ..', () => {
  assert.equal(isOwnMediaPath('bot-altorancho/ig-media/2026-11/abc.jpg'), true);
  assert.equal(isOwnMediaPath('otra-app/secreto.json'), false);
  assert.equal(isOwnMediaPath('bot-altorancho/ig-media/../../otra-app/x'), false);
  assert.equal(isOwnMediaPath(undefined), false);
});
