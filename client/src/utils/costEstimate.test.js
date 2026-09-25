import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, formatUsd, formatArs } from './costEstimate.js';

test('multiplica contactos por la tarifa de la categoría', () => {
  const r = estimateCost({ count: 1240, category: 'MARKETING', pricing: { marketing: 0.0618, utility: 0.026, arsRate: 1200 } });
  assert.equal(r.rate, 0.0618);
  assert.ok(Math.abs(r.usd - 76.632) < 1e-9);
  assert.ok(Math.abs(r.ars - 91958.4) < 1e-6);
});

test('utilidad usa su tarifa; sin cotización ars es null', () => {
  const r = estimateCost({ count: 10, category: 'UTILITY', pricing: { marketing: 0.06, utility: 0.02, arsRate: null } });
  assert.ok(Math.abs(r.usd - 0.2) < 1e-9);
  assert.equal(r.ars, null);
});

test('sin tarifa cargada', () => {
  assert.deepEqual(estimateCost({ count: 10, category: 'MARKETING', pricing: {} }), { missingRate: true });
  assert.deepEqual(estimateCost({ count: 10, category: 'MARKETING', pricing: undefined }), { missingRate: true });
});

test('formatos', () => {
  assert.equal(formatUsd(76.632), 'USD 76,63');
  assert.equal(formatUsd(0.0618), 'USD 0,0618');
  assert.equal(formatArs(91958.4), '$ 91.958');
});
