import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATE_VARS, slugTemplateName, renderPreview } from './templateVars.js';

test('slugTemplateName: minúsculas, sin acentos, _ y sufijo MMDD', () => {
  assert.equal(slugTemplateName('Promo Día del Padre!', new Date(2026, 8, 25)), 'promo_dia_del_padre_0925');
  assert.equal(slugTemplateName('  ', new Date(2026, 0, 5)), 'difusion_0105');
});

test('renderPreview usa el nombre del contacto de muestra y samples', () => {
  assert.equal(
    renderPreview('Hola {{primer_nombre}} ({{nombre}}), gastaste {{gastado}}. {{link}}', 'Ana María López'),
    'Hola Ana (Ana María López), gastaste $ 45.000. https://altorancho.com.ar',
  );
  assert.equal(renderPreview('Hola {{ primer_nombre }}.', null), 'Hola Juan.');
});

test('renderPreview deja los tokens desconocidos a la vista', () => {
  assert.equal(renderPreview('Hola {{apellido}}.', 'Ana'), 'Hola {{apellido}}.');
});

test('claves iguales al backend', () => {
  assert.deepEqual(TEMPLATE_VARS.map(v => v.key), ['nombre', 'primer_nombre', 'pedidos', 'gastado', 'ultimo_pedido', 'link']);
});
