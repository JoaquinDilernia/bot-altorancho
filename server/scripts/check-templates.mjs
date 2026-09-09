// Estado de las plantillas de SimpliRoute en Meta.
// El slot "entregado" se cubre con pedido_entregado O pedido_entregado_v2.
// Exit 0 si los 3 slots están cubiertos (APPROVED + botón), 3 si falta alguno,
// 4 si alguna quedó REJECTED.
import 'dotenv/config';
import axios from 'axios';

const API = 'https://graph.facebook.com/v20.0';
const WATCH = ['pedido_en_camino_v2', 'pedido_entregado', 'pedido_entregado_v2', 'pedido_no_entregado'];
const SLOTS = {
  'en camino': ['pedido_en_camino_v2'],
  'entregado': ['pedido_entregado', 'pedido_entregado_v2'],
  'no entregado': ['pedido_no_entregado'],
};

const { data } = await axios.get(`${API}/${process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`, {
  headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
  params: { fields: 'name,status,components', limit: 100 },
});

const by = {};
for (const name of WATCH) {
  const t = data.data.find(x => x.name === name);
  if (!t) continue;
  by[name] = { status: t.status, hasButton: (t.components ?? []).some(c => c.type === 'BUTTONS') };
}

const ts = new Date().toLocaleTimeString('es-AR');
for (const name of WATCH) {
  const r = by[name];
  if (r) console.log(`[${ts}] ${name.padEnd(22)} ${r.status.padEnd(10)} botón:${r.hasButton ? 'sí' : 'no'}`);
}

const ok = name => by[name]?.status === 'APPROVED' && by[name]?.hasButton;
const slotsCovered = Object.entries(SLOTS).map(([slot, names]) => ({ slot, covered: names.some(ok) }));
console.log('  slots:', slotsCovered.map(s => `${s.slot}:${s.covered ? '✅' : '⏳'}`).join('  '));

if (Object.values(by).some(r => r.status === 'REJECTED')) process.exit(4);
if (slotsCovered.every(s => s.covered)) process.exit(0);
process.exit(3);
