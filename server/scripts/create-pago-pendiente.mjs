// Crea las 2 plantillas del recordatorio de pago por transferencia (sin
// emoji — las que tienen emoji se cuelgan en PENDING en Meta). Quedan
// también en el panel (bot-altorancho_whatsapp_templates) para elegirlas en
// "Pagos pendientes". Variables: {{1}} nombre, {{2}} nº pedido, {{3}} total,
// {{4}} CVU. Botón "Ver datos de pago" → /r/<código> → página de la compra.
//
//   node scripts/create-pago-pendiente.mjs           # dry-run
//   node scripts/create-pago-pendiente.mjs --apply
import 'dotenv/config';
import { initFirebase } from '../src/services/firebase.service.js';
import { createTemplate } from '../src/services/template.service.js';

const APPLY = process.argv.includes('--apply');
const BACKEND_URL = 'https://bot-altorancho-production.up.railway.app';
const EXAMPLES = ['Cecilia', '60356', '$47.607,40', '0000003100099999992528'];
const PARAMS = ['Nombre', 'Número de pedido', 'Total', 'CVU'];

const templates = [
  {
    name: 'pago_pendiente_recordatorio',
    displayName: 'Pago pendiente - 1er recordatorio',
    bodyText: 'Hola {{1}}! Te escribimos de ALTORANCHO. Tu pedido #{{2}} por {{3}} todavía figura pendiente de pago.\n\nPara completarlo, transferí el monto exacto a este CVU:\n{{4}}\n\nSi ya transferiste, ignorá este mensaje. Cualquier duda, respondé por acá y te ayudamos.',
  },
  {
    name: 'pago_pendiente_segundo_aviso',
    displayName: 'Pago pendiente - 2do recordatorio',
    bodyText: 'Hola {{1}}, te recordamos que tu pedido #{{2}} por {{3}} en ALTORANCHO sigue pendiente de pago. Si el pago no se acredita, el pedido puede cancelarse.\n\nCVU para transferir el monto exacto: {{4}}\n\nSi tuviste algún problema para pagar, respondé este mensaje y te ayudamos.',
  },
];

console.log(APPLY ? '=== APPLY ===' : '=== DRY-RUN ===');
if (APPLY) initFirebase();

for (const t of templates) {
  const opts = {
    ...t,
    language: 'es_AR',
    category: 'UTILITY',
    params: PARAMS,
    bodyExamples: EXAMPLES,
    button: { text: 'Ver datos de pago', urlBase: BACKEND_URL },
    strict: true,
  };
  console.log(`\n${t.name}:\n${t.bodyText}`);
  if (APPLY) {
    const created = await createTemplate(opts);
    console.log('→ creada, estado Meta:', created.metaStatus);
  }
}
process.exit(0);
