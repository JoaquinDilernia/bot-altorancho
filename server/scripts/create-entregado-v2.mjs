// Crea pedido_entregado_v2 (sin emoji, con botón "Ver seguimiento"). La v1
// original quedó colgada en PENDING — mismo patrón que pasó con
// pedido_en_camino v1 -> v2 (el emoji parece frenar la aprobación).
//
//   node scripts/create-entregado-v2.mjs           # dry-run
//   node scripts/create-entregado-v2.mjs --apply
import 'dotenv/config';
import axios from 'axios';

const API = 'https://graph.facebook.com/v20.0';
const WABA = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;
const APPLY = process.argv.includes('--apply');

const template = {
  name: 'pedido_entregado_v2',
  language: 'es_AR',
  category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: 'Hola! Te escribimos de ALTORANCHO. Tu pedido #{{1}} fue entregado con éxito. ¡Gracias por tu compra! Ante cualquier consulta, estamos para ayudarte.',
      example: { body_text: [['57529']] },
    },
    {
      type: 'BUTTONS',
      buttons: [{
        type: 'URL',
        text: 'Ver seguimiento',
        url: 'https://livetracking.simpliroute.com/widget/account/100457/tracking/{{1}}',
        example: ['https://livetracking.simpliroute.com/widget/account/100457/tracking/57529'],
      }],
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
