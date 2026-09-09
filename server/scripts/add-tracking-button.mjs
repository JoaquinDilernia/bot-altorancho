// Agrega un botón de URL dinámico "Ver seguimiento" a las 3 plantillas de
// SimpliRoute en Meta. La URL es el Live Tracking de SimpliRoute con el nº de
// pedido como {{1}}.
//
// Uso:
//   node scripts/add-tracking-button.mjs           # dry-run: muestra qué haría
//   node scripts/add-tracking-button.mjs --apply   # aplica (pasa a revisión)
//
// Editar una plantilla APROBADA la manda de nuevo a PENDING, pero la versión
// vigente sigue enviando hasta que Meta apruebe la nueva. Si alguna está en
// PENDING/REJECTED no se puede editar y el script la saltea.

import 'dotenv/config';
import axios from 'axios';

const API = 'https://graph.facebook.com/v20.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const WABA = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
const APPLY = process.argv.includes('--apply');

const TEMPLATES = ['pedido_en_camino_v2', 'pedido_entregado', 'pedido_no_entregado'];

const BUTTON_URL = 'https://livetracking.simpliroute.com/widget/account/100457/tracking/{{1}}';
const BUTTON_EXAMPLE = 'https://livetracking.simpliroute.com/widget/account/100457/tracking/57529';

const buttonsComponent = {
  type: 'BUTTONS',
  buttons: [
    { type: 'URL', text: 'Ver seguimiento', url: BUTTON_URL, example: [BUTTON_EXAMPLE] },
  ],
};

if (!TOKEN || !WABA) {
  console.error('Faltan META_ACCESS_TOKEN o META_WHATSAPP_BUSINESS_ACCOUNT_ID en el .env');
  process.exit(1);
}

const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

async function getTemplate(name) {
  const { data } = await axios.get(`${API}/${WABA}/message_templates`, {
    ...auth,
    params: { name, fields: 'id,name,language,status,category,components', limit: 5 },
  });
  // puede haber varias (distintos idiomas) — tomamos la que matchea el nombre exacto
  return (data.data ?? []).filter(t => t.name === name);
}

async function run() {
  console.log(`\n=== add-tracking-button — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);

  for (const name of TEMPLATES) {
    const matches = await getTemplate(name);
    if (matches.length === 0) {
      console.log(`✗ ${name}: no existe en esta cuenta`);
      continue;
    }
    for (const tpl of matches) {
      const tag = `${tpl.name} [${tpl.language}] (${tpl.status})`;
      if (tpl.status !== 'APPROVED') {
        console.log(`⏭  ${tag}: no está APPROVED, no se puede editar ahora`);
        continue;
      }
      const hasButtons = (tpl.components ?? []).some(c => c.type === 'BUTTONS');
      if (hasButtons) {
        console.log(`✓ ${tag}: ya tiene botones — no se toca`);
        continue;
      }

      const newComponents = [...(tpl.components ?? []), buttonsComponent];
      console.log(`• ${tag}`);
      console.log(`    componentes actuales: ${(tpl.components ?? []).map(c => c.type).join(', ') || '(ninguno)'}`);
      console.log(`    => agrega BUTTONS[URL "Ver seguimiento" -> ${BUTTON_URL}]`);

      if (APPLY) {
        await axios.post(`${API}/${tpl.id}`, { components: newComponents }, {
          headers: { ...auth.headers, 'Content-Type': 'application/json' },
        });
        console.log('    ✔ enviado a revisión');
      }
    }
  }

  console.log(APPLY
    ? '\nListo. Esperá la aprobación de Meta (WhatsApp Manager) y después prendé el toggle en Config.'
    : '\nDry-run terminado. Corré con --apply para aplicar.');
}

run().catch(err => {
  console.error('Error:', err.response?.data ?? err.message);
  process.exit(1);
});
