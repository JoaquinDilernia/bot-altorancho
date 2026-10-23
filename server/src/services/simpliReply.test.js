import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSimpliContext, buildSimpliInstructions, parseAnyEscalation } from './simpliReply.js';

const NOW = Date.parse('2026-10-23T15:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600 * 1000);
const tpl = (name, h = 1, order = '60044') => ({ role: 'admin', content: `[Plantilla: ${name}] pedido #${order}`, timestamp: hoursAgo(h) });

test('detecta la respuesta a pedido_programado', () => {
  const ctx = findSimpliContext([{ role: 'user', content: 'hola' }, tpl('pedido_programado')], NOW);
  assert.deepEqual(ctx, { templateName: 'pedido_programado', orderNumber: '60044', meaning: 'su pedido está programado para entrega' });
});

test('sigue valiendo si el bot ya contestó después de la plantilla', () => {
  const h = [tpl('pedido_en_camino_v2', 5), { role: 'user', content: 'gracias' }, { role: 'assistant', content: '¡De nada!' }];
  assert.equal(findSimpliContext(h, NOW)?.templateName, 'pedido_en_camino_v2');
});

test('acepta timestamps de Firestore', () => {
  const m = { ...tpl('pedido_no_entregado'), timestamp: { _seconds: (NOW - 3600e3) / 1000 } };
  assert.equal(findSimpliContext([m], NOW)?.templateName, 'pedido_no_entregado');
});

test('no aplica si un agente escribió después de la plantilla', () => {
  const h = [tpl('pedido_programado'), { role: 'admin', content: 'Hola, te escribo de logística' }];
  assert.equal(findSimpliContext(h, NOW), null);
});

test('no aplica a plantillas que no son de SimpliRoute', () => {
  assert.equal(findSimpliContext([{ role: 'admin', content: '[Plantilla: retirabelgrano] 14741', timestamp: hoursAgo(1) }], NOW), null);
});

test('no aplica pasadas 72 h', () => {
  assert.equal(findSimpliContext([tpl('pedido_entregado_v2', 73)], NOW), null);
});

test('sin plantilla no hay contexto', () => {
  assert.equal(findSimpliContext([{ role: 'user', content: 'hola' }], NOW), null);
  assert.equal(findSimpliContext([], NOW), null);
});

test('las instrucciones mencionan el pedido, CERRAR y ESCALAR_LOGISTICA', () => {
  const s = buildSimpliInstructions({ templateName: 'pedido_programado', orderNumber: '60044', meaning: 'su pedido está programado para entrega' });
  assert.match(s, /#60044/);
  assert.match(s, /\[CERRAR\]/);
  assert.match(s, /\[ESCALAR_LOGISTICA\]/);
  assert.equal(buildSimpliInstructions(null), '');
});

test('parseAnyEscalation saca cualquier marcador y conserva la oración', () => {
  assert.deepEqual(parseAnyEscalation('Le aviso a logística que lo dejen en seguridad. [ESCALAR_LOGISTICA]'),
    { shouldEscalate: true, cleanText: 'Le aviso a logística que lo dejen en seguridad.' });
  assert.deepEqual(parseAnyEscalation('Te paso con el equipo.\n[ESCALAR_ATENCION]'), { shouldEscalate: true, cleanText: 'Te paso con el equipo.' });
  assert.equal(parseAnyEscalation('Te paso\n[ESCALAR]').shouldEscalate, true);
  assert.deepEqual(parseAnyEscalation('¡Gracias a vos!'), { shouldEscalate: false, cleanText: '¡Gracias a vos!' });
});
