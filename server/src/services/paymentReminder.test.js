import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPendingTransfer, secondReminderAt, dueReminders, fillReminderParams,
  needsCvu, extractCvu, orderPageUrl, CVU_FALLBACK,
} from './paymentReminder.js';

const transfer = (over = {}) => ({
  id: 1,
  number: 60356,
  status: 'open',
  payment_status: 'pending',
  payment_details: { method: 'wire_transfer' },
  created_at: '2026-10-20T17:25:08+0000', // 14:25 hora AR
  ...over,
});

const cfg = { firstTemplate: 'pago_pendiente_1', secondTemplate: 'pago_pendiente_2', firstDelayMinutes: 30, secondHour: 9 };
const at = iso => new Date(iso).getTime();

// --- isPendingTransfer ---

test('isPendingTransfer: transferencia abierta pendiente', () => {
  assert.equal(isPendingTransfer(transfer()), true);
});

test('isPendingTransfer: pagada, anulada, cancelada o tarjeta → false', () => {
  assert.equal(isPendingTransfer(transfer({ payment_status: 'paid' })), false);
  assert.equal(isPendingTransfer(transfer({ payment_status: 'voided' })), false);
  assert.equal(isPendingTransfer(transfer({ status: 'cancelled' })), false);
  assert.equal(isPendingTransfer(transfer({ payment_details: { method: 'credit_card' } })), false);
  assert.equal(isPendingTransfer(null), false);
});

// --- secondReminderAt ---

test('secondReminderAt: día siguiente a las 9 hora AR (12 UTC)', () => {
  assert.equal(new Date(secondReminderAt('2026-10-20T17:25:08+0000', 9)).toISOString(), '2026-10-21T12:00:00.000Z');
});

test('secondReminderAt: compra 22:30 AR (01:30 UTC del día siguiente) cuenta como día AR de la compra', () => {
  assert.equal(new Date(secondReminderAt('2026-10-21T01:30:00+0000', 9)).toISOString(), '2026-10-21T12:00:00.000Z');
});

// --- dueReminders ---

test('dueReminders: antes de los 30 min no toca nada', () => {
  assert.deepEqual(dueReminders(transfer(), {}, at('2026-10-20T17:50:00Z'), cfg), []);
});

test('dueReminders: a los 30 min toca el primero', () => {
  assert.deepEqual(dueReminders(transfer(), {}, at('2026-10-20T17:56:00Z'), cfg), ['first']);
});

test('dueReminders: primero ya enviado → nada hasta las 9 del día siguiente', () => {
  const rec = { first: { status: 'sent' } };
  assert.deepEqual(dueReminders(transfer(), rec, at('2026-10-21T11:59:00Z'), cfg), []);
  assert.deepEqual(dueReminders(transfer(), rec, at('2026-10-21T12:05:00Z'), cfg), ['second']);
});

test('dueReminders: un intento con error no se reintenta', () => {
  const rec = { first: { status: 'error' }, second: { status: 'error' } };
  assert.deepEqual(dueReminders(transfer(), rec, at('2026-10-21T12:05:00Z'), cfg), []);
});

test('dueReminders: primero muy tarde (>12h, ej. backend caído) se saltea', () => {
  assert.deepEqual(dueReminders(transfer(), {}, at('2026-10-21T06:00:00Z'), cfg), []);
});

test('dueReminders: segundo vencido hace >12h se saltea', () => {
  assert.deepEqual(dueReminders(transfer(), { first: { status: 'sent' } }, at('2026-10-22T01:00:00Z'), cfg), []);
});

test('dueReminders: sin plantilla configurada ese paso no corre', () => {
  assert.deepEqual(dueReminders(transfer(), {}, at('2026-10-20T17:56:00Z'), { ...cfg, firstTemplate: '' }), []);
});

test('dueReminders: pedido ya pagado → nada', () => {
  assert.deepEqual(dueReminders(transfer({ payment_status: 'paid' }), {}, at('2026-10-20T17:56:00Z'), cfg), []);
});

// --- fillReminderParams ---

test('fillReminderParams: reemplaza name, firstname, number, total y cvu', () => {
  const order = transfer({ customer: { name: 'Ana Pérez' }, total: '47607.40' });
  assert.deepEqual(
    fillReminderParams(['{{name}}', '{{firstname}}', '#{{number}}', '{{total}}', '{{cvu}}'], order, '0000003100012345678901'),
    ['Ana Pérez', 'Ana', '#60356', '$47.607,40', '0000003100012345678901']
  );
});

test('fillReminderParams: sin CVU usa el texto de respaldo (Meta no acepta variables vacías)', () => {
  assert.deepEqual(fillReminderParams(['{{cvu}}'], transfer(), null), [CVU_FALLBACK]);
});

test('needsCvu: sólo si alguna variable usa {{cvu}}', () => {
  assert.equal(needsCvu(['{{name}}', '{{cvu}}']), true);
  assert.equal(needsCvu(['{{name}}']), false);
  assert.equal(needsCvu(undefined), false);
});

// --- extractCvu ---

test('extractCvu: saca el CVU de la página de la compra (HTML escapado en JSON)', () => {
  const html = String.raw`<p style='font-size:16px'>\n CVU exclusivo para esta compra\n </p>\n <p style='font-weight:bold'>\n 0000003100012345678901\n </p> Beneficiario: Dlocal`;
  assert.equal(extractCvu(html), '0000003100012345678901');
});

test('extractCvu: null si la página no lo trae', () => {
  assert.equal(extractCvu('<html>Gracias por tu compra</html>'), null);
  assert.equal(extractCvu(null), null);
});

// --- orderPageUrl ---

test('orderPageUrl: página de la compra con id + token', () => {
  assert.equal(orderPageUrl({ id: 2099233968, token: 'abc123' }), 'https://altorancho.com/checkout/v3/success/2099233968/abc123');
  assert.equal(orderPageUrl({ id: 1 }), null);
});
