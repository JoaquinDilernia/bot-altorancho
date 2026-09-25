import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMetaBody, resolveVars, sampleValues, sanitizeParam, TEMPLATE_VARS } from './templateVars.js';

test('toMetaBody numera en orden de aparición y reusa tokens repetidos', () => {
  const r = toMetaBody('Hola {{primer_nombre}}! Llevás {{pedidos}} pedidos, {{primer_nombre}}. Mirá: {{link}} ya.');
  assert.equal(r.body, 'Hola {{1}}! Llevás {{2}} pedidos, {{1}}. Mirá: {{3}} ya.');
  assert.deepEqual(r.order, ['primer_nombre', 'pedidos', 'link']);
});

test('toMetaBody acepta espacios y mayúsculas dentro de las llaves', () => {
  const r = toMetaBody('Hola {{ Nombre }}, gracias.');
  assert.equal(r.body, 'Hola {{1}}, gracias.');
  assert.deepEqual(r.order, ['nombre']);
});

test('toMetaBody sin datos devuelve el texto igual y order vacío', () => {
  assert.deepEqual(toMetaBody('Promo de octubre en tienda.'), { body: 'Promo de octubre en tienda.', order: [] });
});

test('toMetaBody rechaza tokens desconocidos', () => {
  assert.throws(() => toMetaBody('Hola {{apellido}}.'), (e) => e.status === 400 && /apellido/.test(e.message));
  assert.throws(() => toMetaBody('Hola {{1}}.'), (e) => e.status === 400);
});

test('toMetaBody rechaza texto que empieza o termina con un dato', () => {
  assert.throws(() => toMetaBody('{{nombre}}, tenemos promo.'), (e) => e.status === 400 && /empezar ni terminar/.test(e.message));
  assert.throws(() => toMetaBody('Mirá la promo {{link}}'), (e) => e.status === 400);
  assert.throws(() => toMetaBody('Mirá la promo {{link}}  \n'), (e) => e.status === 400);
});

test('toMetaBody rechaza texto vacío', () => {
  assert.throws(() => toMetaBody('   '), (e) => e.status === 400);
});

test('resolveVars completa con datos del contacto', () => {
  const contact = { contactName: 'Juan Pérez', tnOrderCount: 3, tnTotalSpent: 45210.6, tnLastOrderAt: '2026-09-12' };
  assert.deepEqual(
    resolveVars(['nombre', 'primer_nombre', 'pedidos', 'gastado', 'ultimo_pedido', 'link'], contact, 'https://x.com/r/abc'),
    ['Juan Pérez', 'Juan', '3', '$ 45.211', '12/09/2026', 'https://x.com/r/abc'],
  );
});

test('resolveVars usa fallback cuando falta el dato', () => {
  assert.deepEqual(
    resolveVars(['nombre', 'primer_nombre', 'pedidos', 'gastado', 'ultimo_pedido', 'link'], {}, null),
    ['Cliente', 'Cliente', '0', '$ 0', '-', '-'],
  );
  assert.deepEqual(resolveVars(['nombre'], { contactName: '   ' }, null), ['Cliente']);
});

test('resolveVars sanea saltos de línea y espacios múltiples', () => {
  assert.deepEqual(resolveVars(['nombre'], { contactName: 'Ana\nMaría     López\t' }, null), ['Ana María López']);
});

test('sanitizeParam nunca devuelve vacío', () => {
  assert.equal(sanitizeParam('\n\t  '), '-');
});

test('sampleValues devuelve un ejemplo por dato', () => {
  assert.deepEqual(sampleValues(['primer_nombre', 'link']), ['Juan', 'https://altorancho.com.ar']);
});

test('todas las claves son [a-z_]', () => {
  for (const v of TEMPLATE_VARS) assert.match(v.key, /^[a-z_]+$/);
});
