// Completa el nombre de los chats y contactos de Instagram que quedaron como
// "Cliente" (o sin nombre), pidiéndole el perfil a la API de Instagram.
// Necesita META_IG_ACCESS_TOKEN y las credenciales de Firebase: correrlo con
// las variables de Railway.
//
//   railway run node scripts/backfill-instagram-names.mjs           # dry-run
//   railway run node scripts/backfill-instagram-names.mjs --apply

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import axios from 'axios';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const APPLY = process.argv.includes('--apply');
const COLLECTIONS = ['bot-altorancho_conversations', 'bot-altorancho_customers'];

const { FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, META_IG_ACCESS_TOKEN } = process.env;
if (!META_IG_ACCESS_TOKEN) throw new Error('Falta META_IG_ACCESS_TOKEN (correr con railway run)');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: FIREBASE_PROJECT_ID,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientEmail: FIREBASE_CLIENT_EMAIL,
  }),
});
const db = admin.firestore();

// El token renovado por el cron vive en Firestore y manda sobre la env.
const stored = (await db.collection('bot-altorancho_config').doc('instagram_token').get()).data();
const TOKEN = stored?.token && stored.sourceEnvToken === META_IG_ACCESS_TOKEN ? stored.token : META_IG_ACCESS_TOKEN;

const { formatInstagramName } = await import('../src/services/meta.service.js');

const names = new Map();
async function lookup(igsid) {
  if (names.has(igsid)) return names.get(igsid);
  try {
    const { data } = await axios.get(`https://graph.instagram.com/v24.0/${igsid}`, {
      params: { fields: 'name,username' },
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    names.set(igsid, formatInstagramName(data));
  } catch (err) {
    console.log(`  ! ${igsid}: ${err.response?.data?.error?.message ?? err.message}`);
    names.set(igsid, null);
  }
  return names.get(igsid);
}

for (const col of COLLECTIONS) {
  const snap = await db.collection(col).where('channel', '==', 'instagram').get();
  const pending = snap.docs.filter(d => !d.data().contactName || d.data().contactName === 'Cliente');
  console.log(`\n${col}: ${snap.size} de IG, ${pending.length} sin nombre`);
  let done = 0;
  for (const doc of pending) {
    const name = await lookup(doc.id);
    if (!name) continue;
    console.log(`  ${doc.id} -> ${name}`);
    if (APPLY) await doc.ref.update({ contactName: name });
    done++;
  }
  console.log(`  ${APPLY ? 'actualizados' : 'a actualizar'}: ${done}`);
}
if (!APPLY) console.log('\n(dry-run: agregá --apply para escribir)');
process.exit(0);
