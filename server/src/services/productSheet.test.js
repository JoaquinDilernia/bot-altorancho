import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProductSheet, pickVariantSku, stripProductDescriptionHtml, productName } from './productSheet.js';

const product = {
  id: 1,
  name: { es: 'Silla Menorca' },
  description: { es: '<link href="x"><p>Material: <b>madera</b> de paraíso</p><p>Altura al apoyabrazos: 65cm&nbsp;</p>' },
  variants: [
    { id: 11, sku: null, values: [{ es: 'Natural' }], width: 55, height: 80, depth: 50 },
    { id: 12, sku: 'SIL123NEG', values: [{ es: 'Negro' }] },
  ],
};

test('stripProductDescriptionHtml deja texto plano', () => {
  assert.equal(stripProductDescriptionHtml(product.description.es), 'Material: madera de paraíso\nAltura al apoyabrazos: 65cm');
});

test('formatProductSheet trae la descripción y no duplica medidas si ya las tiene', () => {
  const s = formatProductSheet(product);
  assert.match(s, /Descripción: Material: madera de paraíso/);
  assert.match(s, /apoyabrazos: 65cm/);
  assert.doesNotMatch(s, /Medidas del sistema/);
});

test('formatProductSheet usa las medidas del sistema si la descripción no tiene', () => {
  const s = formatProductSheet({ description: { es: '<p>Silla de madera</p>' }, variants: [{ width: 55, height: 80, depth: 50 }] });
  assert.match(s, /Ancho 55cm x Alto 80cm x Profundidad 50cm/);
});

test('formatProductSheet recorta descripciones largas', () => {
  const s = formatProductSheet({ description: { es: 'a'.repeat(2000) } }, { maxDesc: 100 });
  assert.ok(s.length < 130);
  assert.ok(s.endsWith('…'));
});

test('formatProductSheet devuelve null sin datos', () => {
  assert.equal(formatProductSheet({ name: 'x', variants: [{ width: '0.00' }] }), null);
});

test('pickVariantSku usa la variante pedida o la primera con SKU', () => {
  assert.equal(pickVariantSku(product, 12).sku, 'SIL123NEG');
  assert.equal(pickVariantSku(product, 11).sku, 'SIL123NEG');
  assert.equal(pickVariantSku(product).sku, 'SIL123NEG');
  assert.equal(pickVariantSku({ variants: [{ id: 1 }] }), null);
});

test('productName acepta string u objeto por idioma', () => {
  assert.equal(productName(product), 'Silla Menorca');
  assert.equal(productName({ name: 'Mesa' }), 'Mesa');
});

test('stripProductDescriptionHtml decodifica tildes y entidades numéricas', () => {
  assert.equal(stripProductDescriptionHtml('<p>Dise&ntilde;o met&aacute;lico &#8211; 40&#xB0;</p>'), 'Diseño metálico – 40°');
});
