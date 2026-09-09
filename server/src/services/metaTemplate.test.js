import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateObject } from './meta.service.js';

test('solo body params', () => {
  const t = buildTemplateObject('pedido_entregado', 'es_AR', ['57529']);
  assert.deepEqual(t, {
    name: 'pedido_entregado',
    language: { code: 'es_AR' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: '57529' }] }],
  });
});

test('body + botón de URL', () => {
  const t = buildTemplateObject('pedido_en_camino_v2', 'es_AR', ['57529'], '57529');
  assert.deepEqual(t.components, [
    { type: 'body', parameters: [{ type: 'text', text: '57529' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '57529' }] },
  ]);
});

test('sin params ni botón -> sin components', () => {
  const t = buildTemplateObject('algo', 'es_AR', []);
  assert.equal(t.components, undefined);
});

test('botón sin body params', () => {
  const t = buildTemplateObject('algo', 'es_AR', [], 'abc123');
  assert.deepEqual(t.components, [
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc123' }] },
  ]);
});
