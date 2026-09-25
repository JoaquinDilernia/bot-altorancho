import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateObject, buildTemplateCreatePayload } from './meta.service.js';

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

test('header de imagen va primero, antes de body y botón', () => {
  const t = buildTemplateObject('promo', 'es_AR', ['Juan'], 'abc123', 'MEDIA_1');
  assert.deepEqual(t.components, [
    { type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA_1' } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Juan' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc123' }] },
  ]);
});

test('header de imagen solo', () => {
  const t = buildTemplateObject('promo', 'es_AR', [], null, 'MEDIA_1');
  assert.deepEqual(t.components, [{ type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA_1' } }] }]);
});

test('payload de creación: sólo body con params mantiene el formato viejo', () => {
  const p = buildTemplateCreatePayload({ name: 'x', language: 'es_AR', category: 'UTILITY', bodyText: 'Hola {{1}}.', params: ['nombre'] });
  assert.deepEqual(p, {
    name: 'x', language: 'es_AR', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}.', example: { body_text: [['ejemplo1']] } }],
  });
});

test('payload de creación: sin params no manda example', () => {
  const p = buildTemplateCreatePayload({ name: 'x', language: 'es_AR', category: 'MARKETING', bodyText: 'Promo.' });
  assert.deepEqual(p.components, [{ type: 'BODY', text: 'Promo.' }]);
});

test('payload de creación: imagen + ejemplos reales + botón URL', () => {
  const p = buildTemplateCreatePayload({
    name: 'promo_0925', language: 'es_AR', category: 'MARKETING',
    bodyText: 'Hola {{1}}, mirá.', params: ['Primer nombre'], bodyExamples: ['Juan'],
    header: { format: 'IMAGE', handle: 'HANDLE_1' },
    button: { text: 'Ver promo', urlBase: 'https://bot.example.com' },
  });
  assert.deepEqual(p.components, [
    { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['HANDLE_1'] } },
    { type: 'BODY', text: 'Hola {{1}}, mirá.', example: { body_text: [['Juan']] } },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver promo', url: 'https://bot.example.com/r/{{1}}', example: ['https://bot.example.com/r/ejemplo1'] }] },
  ]);
});
