import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomerTagMarkers } from './botMarkers.js';

test('extrae [TAG:x] y limpia el texto', () => {
  const r = parseCustomerTagMarkers('Perfecto, te lo reservo. [TAG:Mayorista]');
  assert.deepEqual(r.tags, ['Mayorista']);
  assert.deepEqual(r.newTags, []);
  assert.equal(r.cleanText, 'Perfecto, te lo reservo.');
});

test('extrae [NEW_TAG:x] por separado', () => {
  const r = parseCustomerTagMarkers('Listo [NEW_TAG:Iluminación]');
  assert.deepEqual(r.tags, []);
  assert.deepEqual(r.newTags, ['Iluminación']);
  assert.equal(r.cleanText, 'Listo');
});

test('varios tags, mezcla de TAG y NEW_TAG', () => {
  const r = parseCustomerTagMarkers('ok [TAG:Recurrente] [TAG:Belgrano] [NEW_TAG:Revendedor]');
  assert.deepEqual(r.tags, ['Recurrente', 'Belgrano']);
  assert.deepEqual(r.newTags, ['Revendedor']);
  assert.equal(r.cleanText, 'ok');
});

test('sin marcadores -> arrays vacíos, texto intacto', () => {
  const r = parseCustomerTagMarkers('Hola, ¿en qué te ayudo?');
  assert.deepEqual(r.tags, []);
  assert.deepEqual(r.newTags, []);
  assert.equal(r.cleanText, 'Hola, ¿en qué te ayudo?');
});

test('no confunde [TAG:x] con [NEW_TAG:x] ni con [LABEL:x]', () => {
  const r = parseCustomerTagMarkers('x [NEW_TAG:A] [LABEL:Consulta] [TAG:B]');
  assert.deepEqual(r.tags, ['B']);
  assert.deepEqual(r.newTags, ['A']);
  // deja el [LABEL:...] para que lo maneje parseLabelMarkers
  assert.equal(r.cleanText, 'x [LABEL:Consulta]');
});

test('case-insensitive y con espacios internos', () => {
  const r = parseCustomerTagMarkers('x [tag: Nordelta ] [Tag:Deco]');
  assert.deepEqual(r.tags, ['Nordelta', 'Deco']);
});

test('acepta undefined/null/vacío', () => {
  for (const v of [undefined, null, '']) {
    const r = parseCustomerTagMarkers(v);
    assert.deepEqual(r.tags, []);
    assert.deepEqual(r.newTags, []);
    assert.equal(r.cleanText, '');
  }
});
