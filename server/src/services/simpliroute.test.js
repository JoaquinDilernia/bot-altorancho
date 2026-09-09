import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShipmentContact, buildTrackingUrl } from './simpliroute.service.js';

// --- buildTrackingUrl ---

test('buildTrackingUrl: usa reference si está', () => {
  assert.equal(
    buildTrackingUrl({ reference: '57529', tracking_id: 'SR9318' }, '57529'),
    'https://livetracking.simpliroute.com/widget/account/100457/tracking/57529'
  );
});

test('buildTrackingUrl: cae al número de pedido si no hay reference', () => {
  assert.equal(
    buildTrackingUrl({ tracking_id: 'SR9318' }, '55453'),
    'https://livetracking.simpliroute.com/widget/account/100457/tracking/55453'
  );
});

test('buildTrackingUrl: null si no hay ni reference ni número', () => {
  assert.equal(buildTrackingUrl({}, null), null);
});

// --- resolveShipmentContact ---

const fakes = (over = {}) => ({
  findOrder: async () => null,
  findOdooOrder: async () => null,
  getPartnerContact: async () => null,
  ...over,
});

test('1º: teléfono del propio payload de SimpliRoute', async () => {
  const r = await resolveShipmentContact(
    { contact_phone: '+5491149352595', contact_name: 'Mayra Zappettini' },
    '57529',
    fakes({ findOrder: async () => { throw new Error('no debería llamarse'); } }),
  );
  assert.equal(r.phone, '5491149352595');
  assert.equal(r.name, 'Mayra Zappettini');
  assert.equal(r.source, 'simpliroute');
});

test('2º: TiendaNube si el payload no trae teléfono', async () => {
  const r = await resolveShipmentContact(
    { contact_name: null },
    '57529',
    fakes({ findOrder: async () => ({ number: 57529, customer: { phone: '1149352595', name: 'Mayra' } }) }),
  );
  assert.equal(r.phone, '5491149352595');
  assert.equal(r.name, 'Mayra');
  assert.equal(r.source, 'tiendanube');
});

test('3º: Odoo si no está en TiendaNube', async () => {
  const r = await resolveShipmentContact(
    {},
    'S08121',
    fakes({
      findOdooOrder: async () => ({ order: { partner_id: [42, 'Juan Perez'] } }),
      getPartnerContact: async () => ({ phone: '011 4123-4567', email: 'x@y.com' }),
    }),
  );
  assert.equal(r.phone, '5491141234567');
  assert.equal(r.name, 'Juan Perez');
  assert.equal(r.source, 'odoo');
});

test('null si no se encuentra en ningún lado', async () => {
  const r = await resolveShipmentContact({}, '99999', fakes());
  assert.equal(r, null);
});

test('payload con teléfono vacío -> sigue al fallback', async () => {
  const r = await resolveShipmentContact(
    { contact_phone: '   ' },
    '57529',
    fakes({ findOrder: async () => ({ customer: { phone: '1149352595', name: 'Mayra' } }) }),
  );
  assert.equal(r.source, 'tiendanube');
});
