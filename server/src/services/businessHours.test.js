import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinBusinessHoursAt } from './businessHours.js';

test('martes 10:00 AR está dentro', () => assert.equal(isWithinBusinessHoursAt(new Date('2026-10-20T13:00:00Z')), true));
test('martes 18:00 AR está fuera (fin exclusivo)', () => assert.equal(isWithinBusinessHoursAt(new Date('2026-10-20T21:00:00Z')), false));
test('martes 08:59 AR está fuera', () => assert.equal(isWithinBusinessHoursAt(new Date('2026-10-20T11:59:00Z')), false));
test('sábado 11:00 AR está fuera con config por defecto', () => assert.equal(isWithinBusinessHoursAt(new Date('2026-10-24T14:00:00Z')), false));
test('sábado 11:00 AR está dentro si businessDays incluye 6', () => assert.equal(isWithinBusinessHoursAt(new Date('2026-10-24T14:00:00Z'), { businessDays: [1, 2, 3, 4, 5, 6] }), true));
