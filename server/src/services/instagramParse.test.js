import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagramMessage } from './meta.service.js';

const OWN_IG = '17841414494786646';
process.env.META_IG_PAGE_ID = OWN_IG;

const body = (messaging) => ({ object: 'instagram', entry: [{ messaging: [messaging] }] });

test('parsea un DM entrante de un cliente', () => {
  const msg = parseInstagramMessage(body({ sender: { id: '753624383881906' }, timestamp: 1, message: { mid: 'm1', text: 'holaa' } }));
  assert.equal(msg.from, '753624383881906');
  assert.equal(msg.text, 'holaa');
});

test('ignora el echo de nuestros propios mensajes (is_echo)', () => {
  assert.equal(parseInstagramMessage(body({ sender: { id: OWN_IG }, timestamp: 1, message: { mid: 'm2', text: 'De nada!', is_echo: true } })), null);
});

test('ignora mensajes cuyo sender es nuestra propia cuenta aunque no venga is_echo', () => {
  assert.equal(parseInstagramMessage(body({ sender: { id: OWN_IG }, timestamp: 1, message: { mid: 'm3', text: 'De nada!' } })), null);
});
