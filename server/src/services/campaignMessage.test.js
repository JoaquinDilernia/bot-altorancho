import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateComposer, buildRecipientMessage, assertSendable, isImageExpired, legacyInterpolate } from './campaignMessage.js';

const base = { templateName: 'promo_0925', bodyText: 'Hola {{primer_nombre}}, mirá la promo.', linkMode: 'button', buttonText: 'Ver promo', targetUrl: 'https://tienda.com/promo', publicBaseUrl: 'https://bot.com' };
const is400 = (re) => (e) => e.status === 400 && (!re || re.test(e.message));

test('validateComposer ok con botón', () => {
  assert.deepEqual(validateComposer(base), { body: 'Hola {{1}}, mirá la promo.', order: ['primer_nombre'] });
});

test('validateComposer: nombre técnico inválido', () => {
  assert.throws(() => validateComposer({ ...base, templateName: 'Promo Octubre' }), is400(/nombre técnico/));
});

test('validateComposer: modo texto exige {{link}}', () => {
  assert.throws(() => validateComposer({ ...base, linkMode: 'text' }), is400(/\{\{link\}\}/));
  assert.deepEqual(
    validateComposer({ ...base, linkMode: 'text', bodyText: 'Hola {{nombre}}, entrá a {{link}} ya.' }).order,
    ['nombre', 'link'],
  );
});

test('validateComposer: botón o sin link no admiten {{link}} en el texto', () => {
  assert.throws(() => validateComposer({ ...base, bodyText: 'Entrá a {{link}} ya.' }), is400(/link/));
  assert.throws(() => validateComposer({ ...base, linkMode: 'none', targetUrl: '', bodyText: 'Entrá a {{link}} ya.' }), is400(/link/));
});

test('validateComposer: botón necesita PUBLIC_BASE_URL y texto 1-25', () => {
  assert.throws(() => validateComposer({ ...base, publicBaseUrl: null }), is400(/PUBLIC_BASE_URL/));
  assert.throws(() => validateComposer({ ...base, buttonText: '' }), is400(/botón/));
  assert.throws(() => validateComposer({ ...base, buttonText: 'x'.repeat(26) }), is400(/botón/));
});

test('validateComposer: link exige URL destino http(s)', () => {
  assert.throws(() => validateComposer({ ...base, targetUrl: '' }), is400(/URL/));
  assert.throws(() => validateComposer({ ...base, targetUrl: 'tienda.com' }), is400(/URL/));
});

test('validateComposer: modo inválido', () => {
  assert.throws(() => validateComposer({ ...base, linkMode: 'otro' }), is400());
});

test('buildRecipientMessage con varOrder + botón + imagen', () => {
  const campaign = { varOrder: ['primer_nombre'], linkMode: 'button', headerImage: { mediaId: 'M1' } };
  assert.deepEqual(
    buildRecipientMessage({ campaign, contact: { contactName: 'Ana López' }, link: 'https://bot.com/r/abc', shortCode: 'abc' }),
    { params: ['Ana'], urlButtonParam: 'abc', headerImageId: 'M1' },
  );
});

test('buildRecipientMessage con link en el texto', () => {
  const campaign = { varOrder: ['nombre', 'link'], linkMode: 'text', headerImage: null };
  assert.deepEqual(
    buildRecipientMessage({ campaign, contact: {}, link: 'https://bot.com/r/abc', shortCode: 'abc' }),
    { params: ['Cliente', 'https://bot.com/r/abc'], urlButtonParam: null, headerImageId: null },
  );
});

test('buildRecipientMessage legacy (sin varOrder) mantiene el comportamiento viejo', () => {
  const campaign = { paramsTemplate: ['{{nombre}}', 'Gastaste {{gastado}}', '{{link}}'], targetUrl: 'https://t.com' };
  assert.deepEqual(
    buildRecipientMessage({ campaign, contact: { contactName: 'Ana', tnTotalSpent: 1500.4 }, link: 'https://bot.com/r/x', shortCode: 'x' }),
    { params: ['Ana', 'Gastaste 1500', 'https://bot.com/r/x'], urlButtonParam: null, headerImageId: null },
  );
});

test('legacyInterpolate usa Cliente y 0 por defecto', () => {
  assert.equal(legacyInterpolate('{{nombre}} {{pedidos}} {{gastado}}', {}, null), 'Cliente 0 0');
});

test('isImageExpired: 29 días no, 30 sí; acepta Timestamp de Firestore', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  assert.equal(isImageExpired(new Date('2026-10-01T12:00:00Z'), now), false);
  assert.equal(isImageExpired(new Date('2026-09-30T11:00:00Z'), now), true);
  assert.equal(isImageExpired({ toDate: () => new Date('2026-10-20T00:00:00Z') }, now), false);
  assert.equal(isImageExpired(null, now), true);
});

test('assertSendable: plantilla con imagen sin imagen o vencida', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  assert.throws(() => assertSendable({ templateHasImage: true, headerImage: null }, { publicBaseUrl: 'x', now }), is400(/imagen/));
  assert.throws(() => assertSendable({ templateHasImage: true, headerImage: { mediaId: 'M', uploadedAt: new Date('2026-09-01') } }, { publicBaseUrl: 'x', now }), is400(/Volvé a subir la imagen/));
  assert.doesNotThrow(() => assertSendable({ templateHasImage: true, headerImage: { mediaId: 'M', uploadedAt: new Date('2026-10-29') } }, { publicBaseUrl: 'x', now }));
});

test('assertSendable: botón sin PUBLIC_BASE_URL', () => {
  assert.throws(() => assertSendable({ linkMode: 'button' }, { publicBaseUrl: null, now: new Date() }), is400(/PUBLIC_BASE_URL/));
});

test('assertSendable: campaña legacy pasa', () => {
  assert.doesNotThrow(() => assertSendable({ paramsTemplate: [] }, { publicBaseUrl: null, now: new Date() }));
});

test('assertSendable: plantilla con link sin URL destino', () => {
  const opts = { publicBaseUrl: 'https://bot.com', now: new Date() };
  assert.throws(() => assertSendable({ linkMode: 'button', targetUrl: '' }, opts), is400(/URL destino/));
  assert.throws(() => assertSendable({ linkMode: 'text', targetUrl: '   ' }, opts), is400(/URL destino/));
  assert.throws(() => assertSendable({ linkMode: 'text', targetUrl: null }, opts), is400(/URL destino/));
});

test('assertSendable: sin link o campaña legacy no exigen URL destino', () => {
  const opts = { publicBaseUrl: 'https://bot.com', now: new Date() };
  assert.doesNotThrow(() => assertSendable({ linkMode: 'none', targetUrl: '' }, opts));
  assert.doesNotThrow(() => assertSendable({ linkMode: undefined, targetUrl: '' }, opts));
});
