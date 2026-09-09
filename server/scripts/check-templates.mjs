// Imprime el estado de las 3 plantillas de SimpliRoute en Meta.
// Exit 0 si las 3 están APPROVED, exit 3 si alguna sigue PENDING, exit 4 si REJECTED.
import 'dotenv/config';
import axios from 'axios';

const API = 'https://graph.facebook.com/v20.0';
const WANT = ['pedido_en_camino_v2', 'pedido_entregado', 'pedido_no_entregado'];

const { data } = await axios.get(`${API}/${process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`, {
  headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
  params: { fields: 'name,status,components', limit: 100 },
});

const rows = WANT.map(name => {
  const t = data.data.find(x => x.name === name);
  const btn = (t?.components ?? []).find(c => c.type === 'BUTTONS');
  return { name, status: t?.status ?? 'NO EXISTE', hasButton: !!btn };
});

const ts = new Date().toLocaleTimeString('es-AR');
for (const r of rows) console.log(`[${ts}] ${r.name.padEnd(22)} ${r.status.padEnd(10)} botón:${r.hasButton ? 'sí' : 'no'}`);

if (rows.some(r => r.status === 'REJECTED')) process.exit(4);
if (rows.every(r => r.status === 'APPROVED' && r.hasButton)) process.exit(0);
process.exit(3);
