import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProductUtm, formatWebStock } from './tiendanube.service.js';

test('withProductUtm: suma las UTMs del bot al link del producto', () => {
  assert.equal(
    withProductUtm('https://altorancho.com/productos/silla-cannes/'),
    'https://altorancho.com/productos/silla-cannes/?utm_source=whatsapp&utm_medium=bot&utm_campaign=producto_bot',
  );
  assert.equal(withProductUtm('no es un link'), 'no es un link');
});

test('formatWebStock: el "Link:" que ve el bot ya lleva las UTMs', () => {
  const out = formatWebStock({ id: 1, canonical_url: 'https://altorancho.com/productos/x/', variants: [{ id: 9, stock: 5, values: [] }] });
  assert.match(out, /Link: https:\/\/altorancho\.com\/productos\/x\/\?utm_source=whatsapp&utm_medium=bot&utm_campaign=producto_bot/);
});
