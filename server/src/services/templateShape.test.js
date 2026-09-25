import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTemplateShape } from './template.service.js';

test('detecta header de imagen y botón URL', () => {
  assert.deepEqual(extractTemplateShape([
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'x' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://a/{{1}}' }] },
  ]), { headerFormat: 'IMAGE', hasUrlButton: true });
});

test('plantilla de sólo texto', () => {
  assert.deepEqual(extractTemplateShape([{ type: 'BODY', text: 'x' }]), { headerFormat: null, hasUrlButton: false });
});

test('botones que no son URL no cuentan', () => {
  assert.deepEqual(
    extractTemplateShape([{ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sí' }] }]),
    { headerFormat: null, hasUrlButton: false },
  );
});

test('components ausente', () => {
  assert.deepEqual(extractTemplateShape(undefined), { headerFormat: null, hasUrlButton: false });
});
