// Crea pedido_programado (sin botón — todavía no hay nada que rastrear en
// ese momento). Texto basado en la plantilla nativa "Programado" de
// SimpliRoute (Ajustes > Comunicaciones), agregada 2026-09.
//
//   node scripts/create-programado.mjs           # dry-run
//   node scripts/create-programado.mjs --apply
import 'dotenv/config';
import axios from 'axios';

const API = 'https://graph.facebook.com/v20.0';
const WABA = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;
const APPLY = process.argv.includes('--apply');

const template = {
  name: 'pedido_programado',
  language: 'es_AR',
  category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: 'Hola! Te escribimos de ALTORANCHO. Tu pedido #{{1}} está programado para ser entregado mañana. Cuando el reparto salga te vamos a avisar por acá con el seguimiento en tiempo real y el horario estimado. Si por algún motivo no llegamos a concretar la entrega, nos vamos a comunicar con vos para coordinar la nueva fecha.',
      example: { body_text: [['57529']] },
    },
  ],
};

console.log(APPLY ? '=== APPLY ===' : '=== DRY-RUN ===');
console.log(JSON.stringify(template, null, 2));

if (APPLY) {
  const { data } = await axios.post(`${API}/${WABA}/message_templates`, template, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  console.log('\ncreada:', JSON.stringify(data));
}
