import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInstagramName, parseInstagramMessage } from './meta.service.js';

test('nombre y usuario', () => {
  assert.equal(formatInstagramName({ name: 'sylvie', username: 'sylvierossi16' }), 'sylvie (@sylvierossi16)');
});

test('solo usuario', () => {
  assert.equal(formatInstagramName({ username: 'sylvierossi16' }), '@sylvierossi16');
  assert.equal(formatInstagramName({ name: '  ', username: 'x' }), '@x');
});

test('solo nombre o nada', () => {
  assert.equal(formatInstagramName({ name: 'Ana' }), 'Ana');
  assert.equal(formatInstagramName({}), null);
  assert.equal(formatInstagramName(), null);
});

test('el parse de IG ya no pone "Cliente" fijo', () => {
  const msg = parseInstagramMessage({
    entry: [{ messaging: [{ sender: { id: '123' }, timestamp: 1, message: { mid: 'm1', text: 'hola' } }] }],
  });
  assert.equal(msg.contactName, null);
  assert.equal(msg.from, '123');
});
