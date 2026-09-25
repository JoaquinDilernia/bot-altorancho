import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUtm, slugCampaign, attributeOrders } from './attribution.js';

test('slugCampaign: minúsculas, sin acentos, _', () => {
  assert.equal(slugCampaign('Promo Día del Padre!'), 'promo_dia_del_padre');
  assert.equal(slugCampaign('   '), 'difusion');
});

test('addUtm agrega source/medium/campaign conservando la query existente', () => {
  const u = new URL(addUtm('https://tienda.com/promo?color=rojo#top', { campaignSlug: 'promo_padre' }));
  assert.equal(u.searchParams.get('color'), 'rojo');
  assert.equal(u.searchParams.get('utm_source'), 'whatsapp');
  assert.equal(u.searchParams.get('utm_medium'), 'difusion');
  assert.equal(u.searchParams.get('utm_campaign'), 'promo_padre');
  assert.equal(u.searchParams.get('utm_content'), null);
  assert.equal(u.hash, '#top');
});

test('addUtm con content (pruebas)', () => {
  const u = new URL(addUtm('https://tienda.com/', { campaignSlug: 'x', content: 'prueba' }));
  assert.equal(u.searchParams.get('utm_content'), 'prueba');
});

test('addUtm no pisa UTMs que ya vienen en la URL', () => {
  const url = 'https://tienda.com/?utm_source=ig&utm_campaign=mia';
  assert.equal(addUtm(url, { campaignSlug: 'x', content: 'prueba' }), url);
});

test('addUtm deja igual una URL inválida o vacía', () => {
  assert.equal(addUtm('no es url', { campaignSlug: 'x' }), 'no es url');
  assert.equal(addUtm(null, { campaignSlug: 'x' }), null);
});

const order = (date, total, extra = {}) => ({ number: Math.floor(Math.random() * 1e6), date, total, status: 'open', paymentStatus: 'paid', ...extra });

test('attributeOrders: primer pedido pagado dentro de 7 días desde el día del envío', () => {
  const sends = [
    { contactId: '5491111111111', contactName: 'Ana', status: 'read', sentAt: new Date('2026-09-10T15:00:00Z'), clickedAt: new Date('2026-09-10T16:00:00Z') },
    { contactId: '5491122222222', contactName: 'Beto', status: 'delivered', sentAt: new Date('2026-09-10T15:00:00Z'), clickedAt: null },
    { contactId: '5491133333333', contactName: 'Caro', status: 'delivered', sentAt: new Date('2026-09-10T15:00:00Z'), clickedAt: null },
  ];
  const customers = new Map([
    ['5491111111111', { tnOrders: [order('2026-09-12', '15000.50', { number: 101 }), order('2026-09-11', '9000', { number: 100 })] }],
    ['5491122222222', { tnOrders: [order('2026-09-17', 20000, { number: 200 })] }], // día 7 → cuenta
    ['5491133333333', { tnOrders: [order('2026-09-18', 30000)] }],                    // día 8 → no
  ]);
  const r = attributeOrders({ sends, customersById: customers, windowDays: 7 });
  assert.deepEqual(r.summary, { recipients: 3, buyers: 2, clickedBuyers: 1, revenue: 29000 });
  assert.deepEqual(r.buyers.map(b => [b.contactName, b.orderNumber, b.total, b.clicked]), [
    ['Ana', 100, 9000, true],
    ['Beto', 200, 20000, false],
  ]);
});

test('attributeOrders: ignora pedidos anteriores, cancelados o no pagados', () => {
  const sends = [{ contactId: '5491111111111', status: 'delivered', sentAt: new Date('2026-09-10T15:00:00Z'), clickedAt: null }];
  const customers = new Map([['5491111111111', { tnOrders: [
    order('2026-09-09', 1000),
    order('2026-09-11', 2000, { status: 'cancelled' }),
    order('2026-09-12', 3000, { paymentStatus: 'pending' }),
  ] }]]);
  assert.equal(attributeOrders({ sends, customersById: customers }).summary.buyers, 0);
});

test('attributeOrders: envíos con error no cuentan como destinatarios; acepta Timestamp de Firestore', () => {
  const sends = [
    { contactId: 'a', status: 'error', sentAt: new Date('2026-09-10T15:00:00Z') },
    { contactId: 'b', status: 'sent', sentAt: { toDate: () => new Date('2026-09-10T15:00:00Z') }, clickedAt: null },
  ];
  const customers = new Map([['a', { tnOrders: [order('2026-09-11', 1)] }], ['b', { tnOrders: [order('2026-09-10', 500)] }]]);
  assert.deepEqual(attributeOrders({ sends, customersById: customers }).summary, { recipients: 1, buyers: 1, clickedBuyers: 0, revenue: 500 });
});

test('attributeOrders: contacto sin cliente en Tienda Nube', () => {
  const sends = [{ contactId: 'x', status: 'sent', sentAt: new Date(), clickedAt: null }];
  assert.equal(attributeOrders({ sends, customersById: new Map() }).summary.buyers, 0);
});
