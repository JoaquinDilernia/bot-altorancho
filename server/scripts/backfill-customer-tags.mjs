// Genera tags masivos en los contactos a partir de lo que ya tienen cargado
// (pedidos de Tienda Nube). Usa arrayUnion, así que:
//  - no pisa tags que puso un humano o el bot
//  - es seguro correrlo varias veces
//
//   node scripts/backfill-customer-tags.mjs            # dry-run (no escribe)
//   node scripts/backfill-customer-tags.mjs --apply
//
// Tags que genera:
//  - Recurrente   : 2+ pedidos en Tienda Nube
//  - Sin compras  : 0 pedidos en Tienda Nube
//  - Iluminación / Muebles / Deco : según la 1ª palabra de los productos
//    comprados (mapa RUBRO abajo — editable).

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import admin from 'firebase-admin';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const APPLY = process.argv.includes('--apply');
const COLLECTION = 'bot-altorancho_customers';

// Primera palabra del nombre del producto -> rubro. Sin acentos (se normaliza).
const RUBRO = {
  // Iluminación
  lampara: 'Iluminación', velador: 'Iluminación', veladora: 'Iluminación', aplique: 'Iluminación',
  colgante: 'Iluminación', plafon: 'Iluminación', farol: 'Iluminación', guirnalda: 'Iluminación',
  spot: 'Iluminación', luminaria: 'Iluminación', lampara2: 'Iluminación',
  // Muebles
  mesa: 'Muebles', silla: 'Muebles', sillon: 'Muebles', banco: 'Muebles', banqueta: 'Muebles',
  poltrona: 'Muebles', escritorio: 'Muebles', comoda: 'Muebles', perchero: 'Muebles', estante: 'Muebles',
  consola: 'Muebles', repisa: 'Muebles', biblioteca: 'Muebles', rack: 'Muebles', cama: 'Muebles',
  butaca: 'Muebles', puff: 'Muebles', pouf: 'Muebles', sofa: 'Muebles', mueble: 'Muebles', desk: 'Muebles',
  bar: 'Muebles', vitrina: 'Muebles', cajonera: 'Muebles', mesada: 'Muebles', silla2: 'Muebles',
  // Deco
  vela: 'Deco', portaretrato: 'Deco', portarretrato: 'Deco', plato: 'Deco', bandeja: 'Deco',
  candelabro: 'Deco', planta: 'Deco', libro: 'Deco', cesto: 'Deco', canasto: 'Deco', almohadon: 'Deco',
  vaso: 'Deco', jarron: 'Deco', jarra: 'Deco', ensaladera: 'Deco', alfombra: 'Deco', copa: 'Deco',
  bowl: 'Deco', bowls: 'Deco', funda: 'Deco', mantel: 'Deco', florero: 'Deco', felpudo: 'Deco',
  manta: 'Deco', servilletas: 'Deco', servilleta: 'Deco', individual: 'Deco', tabla: 'Deco', taza: 'Deco',
  cuadro: 'Deco', hielera: 'Deco', repasadores: 'Deco', repasador: 'Deco', cubiertos: 'Deco', adorno: 'Deco',
  adornos: 'Deco', difusor: 'Deco', espejo: 'Deco', frutera: 'Deco', fuente: 'Deco', camino: 'Deco',
  centro: 'Deco', posavaso: 'Deco', posavasos: 'Deco', portavela: 'Deco', portavelas: 'Deco', set: 'Deco',
  vajilla: 'Deco', ramo: 'Deco', flor: 'Deco', hoja: 'Deco', bola: 'Deco', esfera: 'Deco', maceta: 'Deco',
  macetero: 'Deco', llavero: 'Deco', cepillo: 'Deco', dispenser: 'Deco', jabonera: 'Deco', portacosmeticos: 'Deco',
};

const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function firstWord(product) {
  return norm(product).replace(/^set\s+(x\s*\d+\s+|de\s+)?/, '').trim().split(/\s+/)[0] || '';
}

function tagsForCustomer(data) {
  const orders = Array.isArray(data.tnOrders) ? data.tnOrders : [];
  const tags = new Set();
  if (orders.length >= 2) tags.add('Recurrente');
  if (orders.length === 0) tags.add('Sin compras');
  for (const o of orders) {
    for (const p of o.products ?? []) {
      const r = RUBRO[firstWord(p)];
      if (r) tags.add(r);
    }
  }
  return [...tags];
}

const { FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL } = process.env;
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: FIREBASE_PROJECT_ID,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientEmail: FIREBASE_CLIENT_EMAIL,
  }),
});
const db = admin.firestore();

async function run() {
  console.log(`\n=== backfill-customer-tags — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);
  const snap = await db.collection(COLLECTION).get();

  const counts = {};
  const plan = []; // { id, tags }
  const samples = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const tags = tagsForCustomer(data);
    if (tags.length === 0) continue;
    plan.push({ id: doc.id, tags });
    for (const t of tags) counts[t] = (counts[t] ?? 0) + 1;
    if (samples.length < 12 && Math.random() < 0.05) {
      samples.push(`  ${data.contactName ?? doc.id} — ${(data.tnOrders ?? []).length} ped — [${tags.join(', ')}]`);
    }
  }

  console.log(`Contactos totales: ${snap.size}`);
  console.log(`Contactos que reciben ≥1 tag: ${plan.length}\n`);
  console.log('Por tag:');
  for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(14)} ${n}`);
  console.log('\nMuestra:');
  console.log(samples.join('\n'));

  if (!APPLY) {
    console.log('\nDry-run. Corré con --apply para escribir (arrayUnion, no pisa nada).');
    process.exit(0);
  }

  console.log('\nEscribiendo…');
  let written = 0;
  for (let i = 0; i < plan.length; i += 400) {
    const batch = db.batch();
    for (const { id, tags } of plan.slice(i, i + 400)) {
      batch.set(db.collection(COLLECTION).doc(id), {
        tags: admin.firestore.FieldValue.arrayUnion(...tags),
        updatedAt: new Date(),
      }, { merge: true });
    }
    await batch.commit();
    written += Math.min(400, plan.length - i);
    console.log(`  ${written}/${plan.length}`);
  }
  console.log('\nListo.');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
