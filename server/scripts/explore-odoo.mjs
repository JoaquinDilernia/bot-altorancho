/**
 * Script de exploración Odoo — Alto Rancho
 * Corre con: node scripts/explore-odoo.mjs
 * Requiere: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY en .env (o variables de entorno)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Cargar .env manualmente
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../.env');
try {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* si no hay .env, usamos env del sistema */ }

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB  = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_USER;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

if (!ODOO_URL || !ODOO_USER || !ODOO_API_KEY) {
  console.error('Faltan variables: ODOO_URL, ODOO_USER, ODOO_API_KEY');
  process.exit(1);
}

async function rpc(service, method, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0', method: 'call', id: 1,
    params: { service, method, args },
  });
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.message ?? JSON.stringify(json.error));
  return json.result;
}

async function getUid() {
  return rpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
}

async function search_read(uid, model, domain, fields, limit = 20) {
  return rpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_API_KEY,
    model, 'search_read',
    [domain],
    { fields, limit },
  ]);
}

function sep(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  console.log(`Conectando a ${ODOO_URL} (DB: ${ODOO_DB}) ...`);
  const uid = await getUid();
  if (!uid) { console.error('Auth fallida'); process.exit(1); }
  console.log(`✓ Auth OK — UID: ${uid}`);

  // 1. Warehouses
  sep('1. WAREHOUSES (stock.warehouse)');
  const warehouses = await search_read(uid, 'stock.warehouse', [],
    ['id', 'name', 'code', 'lot_stock_id', 'wh_input_stock_loc_id', 'wh_output_stock_loc_id'], 20);
  console.table(warehouses.map(w => ({
    id: w.id,
    name: w.name,
    code: w.code,
    lot_stock_id: w.lot_stock_id,
  })));

  // 2. Locations internas (depósitos)
  sep('2. LOCATIONS INTERNAS (stock.location)');
  const locations = await search_read(uid, 'stock.location',
    [['usage', '=', 'internal'], ['active', '=', true]],
    ['id', 'name', 'complete_name', 'warehouse_id'], 50);
  console.table(locations.map(l => ({
    id: l.id,
    name: l.name,
    complete_name: l.complete_name,
    warehouse_id: l.warehouse_id,
  })));

  // 3. Últimas 10 sale.orders de tipo local (no TN)
  sep('3. ÚLTIMAS ÓRDENES LOCALES (sale.order) — excluyendo TN*');
  const localOrders = await search_read(uid, 'sale.order',
    [['name', 'not ilike', 'TN']],
    ['id', 'name', 'state', 'warehouse_id', 'partner_id', 'date_order', 'amount_total'], 10);
  console.table(localOrders.map(o => ({
    id: o.id,
    name: o.name,
    state: o.state,
    warehouse_id: o.warehouse_id,
    partner: o.partner_id?.[1]?.slice(0, 25),
    date: o.date_order?.slice(0, 10),
    total: o.amount_total,
  })));

  // 4. Últimas 5 órdenes TN para comparar
  sep('4. ÚLTIMAS ÓRDENES WEB/TN (sale.order) — TN*');
  const tnOrders = await search_read(uid, 'sale.order',
    [['name', 'ilike', 'TN']],
    ['id', 'name', 'state', 'warehouse_id', 'date_order'], 5);
  console.table(tnOrders.map(o => ({
    id: o.id,
    name: o.name,
    state: o.state,
    warehouse_id: o.warehouse_id,
    date: o.date_order?.slice(0, 10),
  })));

  // 5. Campos disponibles en sale.order (para saber qué más hay)
  sep('5. CAMPOS DE sale.order (relevantes para sucursal/canal)');
  const orderFields = await rpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_API_KEY,
    'sale.order', 'fields_get',
    [],
    { attributes: ['string', 'type'] },
  ]);
  const relevantKeywords = ['warehouse', 'team', 'channel', 'shop', 'local', 'branch', 'pos', 'sucursal', 'source'];
  const relevant = Object.entries(orderFields)
    .filter(([k, v]) => relevantKeywords.some(kw =>
      k.includes(kw) || v.string?.toLowerCase().includes(kw)
    ))
    .map(([k, v]) => ({ field: k, label: v.string, type: v.type }));
  console.table(relevant);

  // 6. Muestra de stock.quant para ver estructura
  sep('6. MUESTRA stock.quant (primeros 10 con qty > 0)');
  const quants = await search_read(uid, 'stock.quant',
    [['quantity', '>', 0], ['location_id.usage', '=', 'internal']],
    ['product_id', 'location_id', 'quantity', 'reserved_quantity'], 10);
  console.table(quants.map(q => ({
    product: q.product_id?.[1]?.slice(0, 30),
    location: q.location_id?.[1]?.slice(0, 30),
    qty: q.quantity,
    reserved: q.reserved_quantity,
  })));

  // 7. Ejemplo: cómo se guarda el SKU en product.product
  sep('7. CAMPO default_code (SKU) en product.product (primeros 10 con SKU)');
  const products = await search_read(uid, 'product.product',
    [['default_code', '!=', false], ['active', '=', true]],
    ['id', 'name', 'default_code', 'barcode'], 10);
  console.table(products.map(p => ({
    id: p.id,
    name: p.name?.slice(0, 30),
    sku: p.default_code,
    barcode: p.barcode,
  })));

  console.log('\n✓ Exploración completa.\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
