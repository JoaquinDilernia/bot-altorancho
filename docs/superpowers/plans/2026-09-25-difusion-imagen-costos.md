# Difusiones con plantilla inline, imagen y calculadora de costo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desde "Nueva difusión" crear una plantilla de WhatsApp con imagen, datos del contacto y link (botón o texto), esperar la aprobación de Meta, enviarla, y ver el costo estimado.

**Architecture:** Lógica pura nueva en módulos chicos testeables (`templateVars.js`, `campaignMessage.js`, utils del client); `meta.service.js` suma header de imagen, botón URL y la Resumable Upload API; `template.service.js`/`campaign.service.js` orquestan; el front divide `Campaigns.jsx` en `TemplateComposer`, `WhatsAppPreview` y `CostEstimate`.

**Tech Stack:** Node ESM + Express + Firestore (firebase-admin) + axios + multer + sharp; React (Vite) + CSS modules; tests con `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-25-difusion-imagen-costos-design.md`

## Global Constraints

- Idioma de plantillas nuevas: `es_AR`.
- Nombre técnico de plantilla: `^[a-z0-9_]{1,512}$`.
- Texto del botón: 1–25 caracteres, default `Ver promo`.
- URL del botón: `${PUBLIC_BASE_URL}/r/{{1}}` (parámetro = shortCode del destinatario).
- Imagen: sólo `image/*`, multer hasta 16 MB, se recomprime con `ensureWhatsAppImageSize` (≤ 5 MB).
- La imagen de envío (media id de Meta) vence: se rechaza el envío si `uploadedAt` tiene más de 29 días.
- Ningún parámetro de plantilla se manda vacío, con saltos de línea/tabs o con 4+ espacios seguidos (Meta lo rechaza).
- Estados de campaña: `pending_template` → `draft` → `sending` → `sent`, o `template_rejected`.
- Tarifas en config: `pricing: { marketing, utility, arsRate }` (números o null). Nada de tarifas hardcodeadas.
- Las campañas y plantillas existentes deben seguir funcionando igual (camino legacy `paramsTemplate` + `interpolate`).
- Colecciones Firestore con prefijo `bot-altorancho_`.
- Comentarios y textos de UI en español rioplatense, mismo estilo que el código existente.
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Texto que empieza o termina con un dato (`{{nombre}} ...` / `... {{link}}`) → Meta rechaza la plantilla; esperamos un 400 claro antes de llamar a Meta. (Test en Task 1.)
2. Contacto con nombre con salto de línea / muchos espacios o sin nombre → el parámetro sale saneado o con fallback, nunca vacío. (Test en Task 1.)
3. Modo "En el texto" sin `{{link}}` en el texto, o modo "Botón"/"Sin link" con `{{link}}` en el texto → 400 con mensaje entendible. (Test en Task 4.)
4. Plantilla con imagen reutilizada desde el dropdown sin subir imagen, o con imagen de más de 29 días → Enviar devuelve 400 "Volvé a subir la imagen". (Test en Task 4.)
5. Campaña legacy (sin `varOrder`/`linkMode`) → se envía exactamente como antes. (Test en Task 4.)

---

## File map

Backend (`server/src/`):
- Create `services/templateVars.js` — tabla de datos insertables, `toMetaBody`, `resolveVars`, `sampleValues`.
- Create `services/templateVars.test.js`
- Modify `services/meta.service.js` — `buildTemplateObject` (+header), `sendWhatsAppTemplate` (+header), `buildTemplateCreatePayload`, `createMetaTemplate`, `getMetaAppId`, `uploadTemplateSampleImage`, `fetchMetaTemplateStatuses`.
- Modify `services/metaTemplate.test.js`
- Modify `services/template.service.js` — `extractTemplateShape`, `createTemplate` (+header/button/varOrder/strict), `syncTemplateStatuses`, `syncTemplateStatus`.
- Create `services/templateShape.test.js`
- Create `services/campaignMessage.js` — validación del composer, `buildRecipientMessage`, `isImageExpired`, `legacyInterpolate`.
- Create `services/campaignMessage.test.js`
- Modify `services/campaign.service.js` — `createCampaign` (+campos), `createCampaignWithTemplate`, `setCampaignImage`, `refreshTemplateStatus`, `sendCampaign`.
- Modify `routes/campaign.routes.js` — `/meta-info`, `/with-template`, `/:id/image`, `/:id/template-status`.

Frontend (`client/src/`):
- Create `utils/templateVars.js`, `utils/templateVars.test.js`
- Create `utils/costEstimate.js`, `utils/costEstimate.test.js`
- Modify `client/package.json` — script `test`.
- Create `components/Campaigns/TemplateComposer.jsx`, `WhatsAppPreview.jsx`, `CostEstimate.jsx`, `Campaigns.module.css` (estilos de los 3)
- Modify `pages/Campaigns.jsx`, `pages/Campaigns.module.css`
- Modify `pages/Config.jsx`, `pages/Templates.jsx`

---

### Task 1: `templateVars.js` — datos insertables y conversión a formato Meta

**Files:**
- Create: `server/src/services/templateVars.js`
- Test: `server/src/services/templateVars.test.js`

**Interfaces:**
- Produces:
  - `TEMPLATE_VARS: Array<{ key: string, label: string, sample: string, fallback: string, resolve(contact, ctx:{link}) => string|null }>`
  - `toMetaBody(text: string) => { body: string, order: string[] }` — lanza `Error` con `.status = 400`.
  - `resolveVars(order: string[], contact: object, link: string|null) => string[]`
  - `sampleValues(order: string[]) => string[]`
  - `sanitizeParam(value: string) => string`

- [ ] **Step 1: Write the failing test**

`server/src/services/templateVars.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMetaBody, resolveVars, sampleValues, sanitizeParam, TEMPLATE_VARS } from './templateVars.js';

test('toMetaBody numera en orden de aparición y reusa tokens repetidos', () => {
  const r = toMetaBody('Hola {{primer_nombre}}! Llevás {{pedidos}} pedidos, {{primer_nombre}}. Mirá: {{link}} ya.');
  assert.equal(r.body, 'Hola {{1}}! Llevás {{2}} pedidos, {{1}}. Mirá: {{3}} ya.');
  assert.deepEqual(r.order, ['primer_nombre', 'pedidos', 'link']);
});

test('toMetaBody acepta espacios y mayúsculas dentro de las llaves', () => {
  const r = toMetaBody('Hola {{ Nombre }}, gracias.');
  assert.equal(r.body, 'Hola {{1}}, gracias.');
  assert.deepEqual(r.order, ['nombre']);
});

test('toMetaBody sin datos devuelve el texto igual y order vacío', () => {
  assert.deepEqual(toMetaBody('Promo de octubre en tienda.'), { body: 'Promo de octubre en tienda.', order: [] });
});

test('toMetaBody rechaza tokens desconocidos', () => {
  assert.throws(() => toMetaBody('Hola {{apellido}}.'), (e) => e.status === 400 && /apellido/.test(e.message));
  assert.throws(() => toMetaBody('Hola {{1}}.'), (e) => e.status === 400);
});

test('toMetaBody rechaza texto que empieza o termina con un dato', () => {
  assert.throws(() => toMetaBody('{{nombre}}, tenemos promo.'), (e) => e.status === 400 && /empezar ni terminar/.test(e.message));
  assert.throws(() => toMetaBody('Mirá la promo {{link}}'), (e) => e.status === 400);
  assert.throws(() => toMetaBody('Mirá la promo {{link}}  \n'), (e) => e.status === 400);
});

test('toMetaBody rechaza texto vacío', () => {
  assert.throws(() => toMetaBody('   '), (e) => e.status === 400);
});

test('resolveVars completa con datos del contacto', () => {
  const contact = { contactName: 'Juan Pérez', tnOrderCount: 3, tnTotalSpent: 45210.6, tnLastOrderAt: '2026-09-12' };
  assert.deepEqual(
    resolveVars(['nombre', 'primer_nombre', 'pedidos', 'gastado', 'ultimo_pedido', 'link'], contact, 'https://x.com/r/abc'),
    ['Juan Pérez', 'Juan', '3', '$ 45.211', '12/09/2026', 'https://x.com/r/abc'],
  );
});

test('resolveVars usa fallback cuando falta el dato', () => {
  assert.deepEqual(
    resolveVars(['nombre', 'primer_nombre', 'pedidos', 'gastado', 'ultimo_pedido', 'link'], {}, null),
    ['Cliente', 'Cliente', '0', '$ 0', '-', '-'],
  );
  assert.deepEqual(resolveVars(['nombre'], { contactName: '   ' }, null), ['Cliente']);
});

test('resolveVars sanea saltos de línea y espacios múltiples', () => {
  assert.deepEqual(resolveVars(['nombre'], { contactName: 'Ana\nMaría     López\t' }, null), ['Ana María López']);
});

test('sanitizeParam nunca devuelve vacío', () => {
  assert.equal(sanitizeParam('\n\t  '), '-');
});

test('sampleValues devuelve un ejemplo por dato', () => {
  assert.deepEqual(sampleValues(['primer_nombre', 'link']), ['Juan', 'https://altorancho.com.ar']);
});

test('todas las claves son [a-z_]', () => {
  for (const v of TEMPLATE_VARS) assert.match(v.key, /^[a-z_]+$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/templateVars.test.js`
Expected: FAIL — `Cannot find module ... templateVars.js`

- [ ] **Step 3: Write implementation**

`server/src/services/templateVars.js`:

```js
// Datos del contacto que se pueden insertar en una plantilla creada desde
// Difusiones. El texto se escribe con tokens legibles ({{primer_nombre}}) y
// acá se traducen al formato numerado que exige Meta ({{1}}, {{2}}…).

function firstWord(name) {
  const w = (name ?? '').trim().split(/\s+/)[0];
  return w || null;
}

function formatMoney(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return null;
  return `$ ${String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

// tnLastOrderAt se guarda como 'YYYY-MM-DD' (customer.service.js).
function formatDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export const TEMPLATE_VARS = [
  { key: 'nombre', label: 'Nombre completo', sample: 'Juan Pérez', fallback: 'Cliente',
    resolve: (c) => c.contactName?.trim() || null },
  { key: 'primer_nombre', label: 'Primer nombre', sample: 'Juan', fallback: 'Cliente',
    resolve: (c) => firstWord(c.contactName) },
  { key: 'pedidos', label: 'Cantidad de pedidos', sample: '3', fallback: '0',
    resolve: (c) => (c.tnOrderCount === null || c.tnOrderCount === undefined ? null : String(c.tnOrderCount)) },
  { key: 'gastado', label: 'Total gastado', sample: '$ 45.000', fallback: '$ 0',
    resolve: (c) => formatMoney(c.tnTotalSpent) },
  { key: 'ultimo_pedido', label: 'Fecha del último pedido', sample: '12/09/2026', fallback: '-',
    resolve: (c) => formatDay(c.tnLastOrderAt) },
  { key: 'link', label: 'Link de la promo', sample: 'https://altorancho.com.ar', fallback: '-',
    resolve: (_c, ctx) => ctx?.link || null },
];

const VAR_MAP = Object.fromEntries(TEMPLATE_VARS.map(v => [v.key, v]));
const TOKEN_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/** Meta rechaza parámetros vacíos, con \n / \t o con 4+ espacios seguidos. */
export function sanitizeParam(value) {
  const clean = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return clean || '-';
}

export function toMetaBody(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw badRequest('El texto del mensaje es obligatorio');
  const order = [];
  const body = trimmed.replace(TOKEN_RE, (_m, raw) => {
    const key = raw.toLowerCase();
    if (!VAR_MAP[key]) throw badRequest(`Dato desconocido en el texto: {{${raw}}}`);
    let idx = order.indexOf(key);
    if (idx === -1) { order.push(key); idx = order.length - 1; }
    return `{{${idx + 1}}}`;
  });
  if (order.length > 0 && (/^\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}$/.test(body))) {
    throw badRequest('El texto no puede empezar ni terminar con un dato (Meta lo rechaza). Agregá un saludo antes o un punto al final.');
  }
  return { body, order };
}

export function resolveVars(order, contact, link) {
  return order.map((key) => {
    const v = VAR_MAP[key];
    const value = v.resolve(contact ?? {}, { link });
    const clean = value === null || value === undefined ? '' : sanitizeParam(value);
    return clean && clean !== '-' ? clean : v.fallback;
  });
}

export function sampleValues(order) {
  return order.map(key => VAR_MAP[key].sample);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/templateVars.test.js`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/templateVars.js server/src/services/templateVars.test.js
git commit -m "feat(campaigns): datos insertables para plantillas y conversión al formato de Meta"
```

---

### Task 2: `meta.service.js` — header de imagen, botón URL, subida de imagen de ejemplo

**Files:**
- Modify: `server/src/services/meta.service.js:183-213` (`buildTemplateObject`, `sendWhatsAppTemplate`), `:315-349` (`createMetaTemplate`, `fetchMetaTemplateStatuses`)
- Test: `server/src/services/metaTemplate.test.js`

**Interfaces:**
- Produces:
  - `buildTemplateObject(name, language, params = [], urlButtonParam = null, headerImageId = null)`
  - `sendWhatsAppTemplate(to, name, language = 'es_AR', params = [], urlButtonParam = null, headerImageId = null) => Promise<string|null>`
  - `buildTemplateCreatePayload({ name, language, category, bodyText, params = [], bodyExamples = null, header = null, button = null })` — `header: { format: 'IMAGE', handle }`, `button: { text, urlBase }`
  - `createMetaTemplate(sameArgs) => Promise<{ id, status }>`
  - `getMetaAppId() => Promise<string>`
  - `uploadTemplateSampleImage(buffer: Buffer, mimeType: string) => Promise<string>` (handle)
  - `fetchMetaTemplateStatuses() => Promise<Array<{ name, status, language, category, components, rejected_reason }>>`

- [ ] **Step 1: Write the failing tests** — agregar al final de `server/src/services/metaTemplate.test.js` y actualizar el import:

```js
import { buildTemplateObject, buildTemplateCreatePayload } from './meta.service.js';

test('header de imagen va primero, antes de body y botón', () => {
  const t = buildTemplateObject('promo', 'es_AR', ['Juan'], 'abc123', 'MEDIA_1');
  assert.deepEqual(t.components, [
    { type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA_1' } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Juan' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc123' }] },
  ]);
});

test('header de imagen solo', () => {
  const t = buildTemplateObject('promo', 'es_AR', [], null, 'MEDIA_1');
  assert.deepEqual(t.components, [{ type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA_1' } }] }]);
});

test('payload de creación: sólo body con params mantiene el formato viejo', () => {
  const p = buildTemplateCreatePayload({ name: 'x', language: 'es_AR', category: 'UTILITY', bodyText: 'Hola {{1}}.', params: ['nombre'] });
  assert.deepEqual(p, {
    name: 'x', language: 'es_AR', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}.', example: { body_text: [['ejemplo1']] } }],
  });
});

test('payload de creación: sin params no manda example', () => {
  const p = buildTemplateCreatePayload({ name: 'x', language: 'es_AR', category: 'MARKETING', bodyText: 'Promo.' });
  assert.deepEqual(p.components, [{ type: 'BODY', text: 'Promo.' }]);
});

test('payload de creación: imagen + ejemplos reales + botón URL', () => {
  const p = buildTemplateCreatePayload({
    name: 'promo_0925', language: 'es_AR', category: 'MARKETING',
    bodyText: 'Hola {{1}}, mirá.', params: ['Primer nombre'], bodyExamples: ['Juan'],
    header: { format: 'IMAGE', handle: 'HANDLE_1' },
    button: { text: 'Ver promo', urlBase: 'https://bot.example.com' },
  });
  assert.deepEqual(p.components, [
    { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['HANDLE_1'] } },
    { type: 'BODY', text: 'Hola {{1}}, mirá.', example: { body_text: [['Juan']] } },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver promo', url: 'https://bot.example.com/r/{{1}}', example: ['https://bot.example.com/r/ejemplo1'] }] },
  ]);
});
```

(El import existente `import { buildTemplateObject } from './meta.service.js';` se reemplaza por el de arriba.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/metaTemplate.test.js`
Expected: FAIL — `buildTemplateCreatePayload` no exportado / header no presente.

- [ ] **Step 3: Implement**

Reemplazar `buildTemplateObject` y `sendWhatsAppTemplate` (`meta.service.js:183-213`) por:

```js
export function buildTemplateObject(templateName, language, params = [], urlButtonParam = null, headerImageId = null) {
  const template = { name: templateName, language: { code: language } };
  const components = [];
  if (headerImageId) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { id: headerImageId } }] });
  }
  if (params.length > 0) {
    components.push({ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) });
  }
  if (urlButtonParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(urlButtonParam) }],
    });
  }
  if (components.length > 0) template.components = components;
  return template;
}

export async function sendWhatsAppTemplate(to, templateName, language = 'es_AR', params = [], urlButtonParam = null, headerImageId = null) {
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PHONE_NUMBER_ID) {
    console.log('[meta] sendWhatsAppTemplate skipped — tokens not configured');
    return null;
  }
  const template = buildTemplateObject(templateName, language, params, urlButtonParam, headerImageId);
  const { data } = await axios.post(
    `${META_API_URL}/${process.env.META_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template },
    { headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  return data.messages?.[0]?.id ?? null;
}
```

Reemplazar `createMetaTemplate` y `fetchMetaTemplateStatuses` (`meta.service.js:315-349`) por:

```js
/** Arma el body de POST /{waba}/message_templates. Pura para poder testearla. */
export function buildTemplateCreatePayload({ name, language, category, bodyText, params = [], bodyExamples = null, header = null, button = null }) {
  const components = [];
  if (header?.format === 'IMAGE') {
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [header.handle] } });
  }
  const bodyComponent = { type: 'BODY', text: bodyText };
  // Meta exige un valor de ejemplo por cada variable del body
  const examples = bodyExamples ?? params.map((_, i) => `ejemplo${i + 1}`);
  if (examples.length > 0) bodyComponent.example = { body_text: [examples] };
  components.push(bodyComponent);
  if (button) {
    components.push({
      type: 'BUTTONS',
      buttons: [{
        type: 'URL',
        text: button.text,
        url: `${button.urlBase}/r/{{1}}`,
        example: [`${button.urlBase}/r/ejemplo1`],
      }],
    });
  }
  return { name, language, category, components };
}

export async function createMetaTemplate(opts) {
  const wabaId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token  = process.env.META_ACCESS_TOKEN;
  if (!wabaId || !token) {
    throw new Error('META_WHATSAPP_BUSINESS_ACCOUNT_ID o META_ACCESS_TOKEN no configurados');
  }
  const { data } = await axios.post(
    `${META_API_URL}/${wabaId}/message_templates`,
    buildTemplateCreatePayload(opts),
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data; // { id, status, ... }
}

let cachedAppId = null;

/** La Resumable Upload API cuelga del App ID, no del WABA. Se saca del
    propio token (debug_token) para no pedir otra variable en Railway;
    META_APP_ID la pisa si alguna vez el token no alcanza. */
export async function getMetaAppId() {
  if (process.env.META_APP_ID) return process.env.META_APP_ID;
  if (cachedAppId) return cachedAppId;
  const token = process.env.META_ACCESS_TOKEN;
  try {
    const { data } = await axios.get(`${META_API_URL}/debug_token`, {
      params: { input_token: token, access_token: token },
    });
    cachedAppId = data?.data?.app_id ?? null;
  } catch (err) {
    console.error('[meta] getMetaAppId error:', err.response?.data ?? err.message);
  }
  if (!cachedAppId) throw new Error('No se pudo obtener el App ID de Meta; cargá META_APP_ID en Railway');
  return cachedAppId;
}

/** Sube la imagen de ejemplo que Meta exige para aprobar un header IMAGE y
    devuelve el handle. No sirve para enviar — para eso está uploadMetaMedia. */
export async function uploadTemplateSampleImage(buffer, mimeType) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN no configurado');
  const appId = await getMetaAppId();
  const { data: session } = await axios.post(`${META_API_URL}/${appId}/uploads`, null, {
    params: { file_name: 'header', file_length: buffer.length, file_type: mimeType, access_token: token },
  });
  const { data } = await axios.post(`${META_API_URL}/${session.id}`, buffer, {
    headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'Content-Type': mimeType },
    maxBodyLength: Infinity,
  });
  if (!data?.h) throw new Error('Meta no devolvió el handle de la imagen');
  return data.h;
}

export async function fetchMetaTemplateStatuses() {
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID) return [];
  try {
    const { data } = await axios.get(
      `${META_API_URL}/${process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`,
      {
        headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
        params: { fields: 'name,status,language,category,components,rejected_reason', limit: 100 },
      }
    );
    return data.data ?? [];
  } catch (err) {
    console.error('[meta] fetchMetaTemplateStatuses error:', err.response?.data ?? err.message);
    return [];
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd server && npm test`
Expected: PASS (todos, incluidos los 4 tests viejos de `metaTemplate.test.js` sin cambios)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/meta.service.js server/src/services/metaTemplate.test.js
git commit -m "feat(meta): plantillas con header de imagen y botón URL + subida de imagen de ejemplo"
```

---

### Task 3: `template.service.js` — guardar forma de la plantilla y sync de una sola

**Files:**
- Modify: `server/src/services/template.service.js`
- Test: `server/src/services/templateShape.test.js`

**Interfaces:**
- Consumes: `createMetaTemplate(opts)`, `fetchMetaTemplateStatuses()` (Task 2).
- Produces:
  - `extractTemplateShape(components = []) => { headerFormat: string|null, hasUrlButton: boolean }` (pura)
  - `createTemplate({ name, displayName, bodyText, language, category, params, header = null, button = null, bodyExamples = null, varOrder = null, linkMode = null, strict = false }) => Promise<TemplateDoc>` — con `strict: true`, si Meta falla lanza `Error` con `.status = 502` y **no** guarda nada.
  - `syncTemplateStatus(name, language) => Promise<{ status: string|null, rejectedReason: string|null }>`
  - TemplateDoc suma: `headerFormat`, `hasUrlButton`, `button: { text, urlBase }|null`, `varOrder: string[]|null`, `linkMode: 'button'|'text'|'none'|null`, `rejectedReason`.

- [ ] **Step 1: Write the failing test**

`server/src/services/templateShape.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTemplateShape } from './template.service.js';

test('detecta header de imagen y botón URL', () => {
  assert.deepEqual(extractTemplateShape([
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'x' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://a/{{1}}' }] },
  ]), { headerFormat: 'IMAGE', hasUrlButton: true });
});

test('plantilla de sólo texto', () => {
  assert.deepEqual(extractTemplateShape([{ type: 'BODY', text: 'x' }]), { headerFormat: null, hasUrlButton: false });
});

test('botones que no son URL no cuentan', () => {
  assert.deepEqual(
    extractTemplateShape([{ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sí' }] }]),
    { headerFormat: null, hasUrlButton: false },
  );
});

test('components ausente', () => {
  assert.deepEqual(extractTemplateShape(undefined), { headerFormat: null, hasUrlButton: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/templateShape.test.js`
Expected: FAIL — `extractTemplateShape` no exportado.

- [ ] **Step 3: Implement** — reemplazar `createTemplate` y `syncTemplateStatuses` y agregar las nuevas funciones en `template.service.js`:

```js
/** Qué tiene la plantilla aprobada en Meta — así se detectan también las
    creadas a mano en Business Manager (no sólo las del panel). */
export function extractTemplateShape(components = []) {
  const list = Array.isArray(components) ? components : [];
  const header = list.find(c => c.type === 'HEADER');
  const buttons = list.find(c => c.type === 'BUTTONS')?.buttons ?? [];
  return {
    headerFormat: header?.format ?? null,
    hasUrlButton: buttons.some(b => b.type === 'URL'),
  };
}

export async function createTemplate({
  name, displayName, bodyText, language, category, params,
  header = null, button = null, bodyExamples = null, varOrder = null, linkMode = null, strict = false,
}) {
  const cleanName = name.trim();
  const cleanLanguage = language?.trim() || 'es_AR';
  const cleanParams = Array.isArray(params) ? params : [];

  // Submit to Meta for approval — errors are surfaced so the caller can inform the user
  let metaStatus = 'PENDING';
  let metaSubmitError = null;
  try {
    const result = await createMetaTemplate({
      name: cleanName,
      language: cleanLanguage,
      category: category || 'UTILITY',
      bodyText: bodyText.trim(),
      params: cleanParams,
      bodyExamples,
      header,
      button,
    });
    metaStatus = result.status ?? 'PENDING';
  } catch (err) {
    const detail = err.response?.data?.error?.error_user_msg ?? err.response?.data?.error?.message ?? err.message;
    console.error('[template] Error submitting to Meta:', detail);
    // Desde Difusiones no tiene sentido guardar una plantilla que Meta nunca
    // va a aprobar: se corta acá y el agente ve el motivo en el formulario.
    if (strict) {
      const e = new Error(`Meta rechazó la plantilla: ${detail}`);
      e.status = 502;
      throw e;
    }
    metaSubmitError = detail;
    // Don't throw — still save locally so agent knows the template exists
  }

  const db = getDb();
  const doc = await db.collection(COLLECTION).add({
    name: cleanName,
    displayName: displayName.trim(),
    bodyText: bodyText.trim(),
    language: cleanLanguage,
    category: category || 'UTILITY',
    params: cleanParams,
    headerFormat: header?.format ?? null,
    hasUrlButton: !!button,
    button: button ? { text: button.text, urlBase: button.urlBase } : null,
    varOrder: varOrder ?? null,
    linkMode: linkMode ?? null,
    metaStatus,
    metaSubmitError: metaSubmitError ?? null,
    rejectedReason: null,
    createdAt: new Date(),
  });
  const snap = await doc.get();
  return { id: snap.id, ...snap.data() };
}

function metaMatchFor(metaTemplates, name, language) {
  return metaTemplates.find(t => t.name === name && t.language === language)
    ?? metaTemplates.find(t => t.name === name);
}

function syncFields(metaMatch) {
  const fields = { metaStatus: metaMatch.status, rejectedReason: metaMatch.rejected_reason && metaMatch.rejected_reason !== 'NONE' ? metaMatch.rejected_reason : null };
  if (metaMatch.components) Object.assign(fields, extractTemplateShape(metaMatch.components));
  return fields;
}

export async function syncTemplateStatuses() {
  const metaTemplates = await fetchMetaTemplateStatuses();
  if (metaTemplates.length === 0) return;
  const db = getDb();
  const snap = await db.collection(COLLECTION).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) {
    const { name, language } = doc.data();
    const metaMatch = metaMatchFor(metaTemplates, name, language);
    if (metaMatch) batch.update(doc.ref, syncFields(metaMatch));
  }
  await batch.commit();
}

/** Sync de una sola plantilla — lo usa el polling de "Esperando aprobación". */
export async function syncTemplateStatus(name, language) {
  const metaTemplates = await fetchMetaTemplateStatuses();
  const metaMatch = metaMatchFor(metaTemplates, name, language);
  if (!metaMatch) return { status: null, rejectedReason: null };
  const fields = syncFields(metaMatch);
  const db = getDb();
  const snap = await db.collection(COLLECTION).where('name', '==', name).get();
  await Promise.all(snap.docs.map(d => d.ref.update(fields)));
  return { status: fields.metaStatus, rejectedReason: fields.rejectedReason };
}
```

- [ ] **Step 4: Run tests**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/template.service.js server/src/services/templateShape.test.js
git commit -m "feat(templates): guardar header/botón/variables y sync de una sola plantilla"
```

---

### Task 4: `campaignMessage.js` + `campaign.service.js` + rutas

**Files:**
- Create: `server/src/services/campaignMessage.js`
- Test: `server/src/services/campaignMessage.test.js`
- Modify: `server/src/services/campaign.service.js`
- Modify: `server/src/routes/campaign.routes.js`

**Interfaces:**
- Consumes: `toMetaBody`, `resolveVars`, `sampleValues`, `TEMPLATE_VARS` (Task 1); `sendWhatsAppTemplate(..., headerImageId)`, `uploadTemplateSampleImage`, `uploadMetaMedia`, `ensureWhatsAppImageSize` (Task 2 / existentes); `createTemplate({... strict })`, `syncTemplateStatus` (Task 3).
- Produces (HTTP, consumido por Task 6):
  - `GET /api/campaigns/meta-info` → `{ canUseButton: boolean }`
  - `POST /api/campaigns` — body JSON suma `varOrder`, `linkMode`, `templateHasImage`.
  - `POST /api/campaigns/with-template` — multipart: `data` (JSON `{ name, templateName, category, bodyText, linkMode, buttonText, targetUrl, segment }`), `image` (opcional) → `201 { campaign }`
  - `POST /api/campaigns/:id/image` — multipart `image` → `{ campaign }`
  - `GET /api/campaigns/:id/template-status` → `{ campaign }`
  - Campaign doc suma: `varOrder`, `linkMode`, `templateHasImage`, `headerImage: { mediaId, uploadedAt }|null`, `templateStatus`, `templateRejectedReason`.
- Produces (puras, `campaignMessage.js`):
  - `validateComposer({ templateName, bodyText, linkMode, buttonText, targetUrl, publicBaseUrl }) => { body, order }` (lanza 400)
  - `buildRecipientMessage({ campaign, contact, link, shortCode }) => { params, urlButtonParam, headerImageId }`
  - `assertSendable(campaign, { publicBaseUrl, now })` (lanza 400)
  - `isImageExpired(uploadedAt, now = new Date()) => boolean`
  - `legacyInterpolate(template, contact, link) => string`

- [ ] **Step 1: Write the failing test**

`server/src/services/campaignMessage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateComposer, buildRecipientMessage, assertSendable, isImageExpired, legacyInterpolate } from './campaignMessage.js';

const base = { templateName: 'promo_0925', bodyText: 'Hola {{primer_nombre}}, mirá la promo.', linkMode: 'button', buttonText: 'Ver promo', targetUrl: 'https://tienda.com/promo', publicBaseUrl: 'https://bot.com' };
const is400 = (re) => (e) => e.status === 400 && (!re || re.test(e.message));

test('validateComposer ok con botón', () => {
  assert.deepEqual(validateComposer(base), { body: 'Hola {{1}}, mirá la promo.', order: ['primer_nombre'] });
});

test('validateComposer: nombre técnico inválido', () => {
  assert.throws(() => validateComposer({ ...base, templateName: 'Promo Octubre' }), is400(/nombre técnico/));
});

test('validateComposer: modo texto exige {{link}}', () => {
  assert.throws(() => validateComposer({ ...base, linkMode: 'text' }), is400(/\{\{link\}\}/));
  assert.deepEqual(
    validateComposer({ ...base, linkMode: 'text', bodyText: 'Hola {{nombre}}, entrá a {{link}} ya.' }).order,
    ['nombre', 'link'],
  );
});

test('validateComposer: botón o sin link no admiten {{link}} en el texto', () => {
  assert.throws(() => validateComposer({ ...base, bodyText: 'Entrá a {{link}} ya.' }), is400(/link/));
  assert.throws(() => validateComposer({ ...base, linkMode: 'none', targetUrl: '', bodyText: 'Entrá a {{link}} ya.' }), is400(/link/));
});

test('validateComposer: botón necesita PUBLIC_BASE_URL y texto 1-25', () => {
  assert.throws(() => validateComposer({ ...base, publicBaseUrl: null }), is400(/PUBLIC_BASE_URL/));
  assert.throws(() => validateComposer({ ...base, buttonText: '' }), is400(/botón/));
  assert.throws(() => validateComposer({ ...base, buttonText: 'x'.repeat(26) }), is400(/botón/));
});

test('validateComposer: link exige URL destino http(s)', () => {
  assert.throws(() => validateComposer({ ...base, targetUrl: '' }), is400(/URL/));
  assert.throws(() => validateComposer({ ...base, targetUrl: 'tienda.com' }), is400(/URL/));
});

test('validateComposer: modo inválido', () => {
  assert.throws(() => validateComposer({ ...base, linkMode: 'otro' }), is400());
});

test('buildRecipientMessage con varOrder + botón + imagen', () => {
  const campaign = { varOrder: ['primer_nombre'], linkMode: 'button', headerImage: { mediaId: 'M1' } };
  assert.deepEqual(
    buildRecipientMessage({ campaign, contact: { contactName: 'Ana López' }, link: 'https://bot.com/r/abc', shortCode: 'abc' }),
    { params: ['Ana'], urlButtonParam: 'abc', headerImageId: 'M1' },
  );
});

test('buildRecipientMessage con link en el texto', () => {
  const campaign = { varOrder: ['nombre', 'link'], linkMode: 'text', headerImage: null };
  assert.deepEqual(
    buildRecipientMessage({ campaign, contact: {}, link: 'https://bot.com/r/abc', shortCode: 'abc' }),
    { params: ['Cliente', 'https://bot.com/r/abc'], urlButtonParam: null, headerImageId: null },
  );
});

test('buildRecipientMessage legacy (sin varOrder) mantiene el comportamiento viejo', () => {
  const campaign = { paramsTemplate: ['{{nombre}}', 'Gastaste {{gastado}}', '{{link}}'], targetUrl: 'https://t.com' };
  assert.deepEqual(
    buildRecipientMessage({ campaign, contact: { contactName: 'Ana', tnTotalSpent: 1500.4 }, link: 'https://bot.com/r/x', shortCode: 'x' }),
    { params: ['Ana', 'Gastaste 1500', 'https://bot.com/r/x'], urlButtonParam: null, headerImageId: null },
  );
});

test('legacyInterpolate usa Cliente y 0 por defecto', () => {
  assert.equal(legacyInterpolate('{{nombre}} {{pedidos}} {{gastado}}', {}, null), 'Cliente 0 0');
});

test('isImageExpired: 29 días no, 30 sí; acepta Timestamp de Firestore', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  assert.equal(isImageExpired(new Date('2026-10-01T12:00:00Z'), now), false);
  assert.equal(isImageExpired(new Date('2026-09-30T11:00:00Z'), now), true);
  assert.equal(isImageExpired({ toDate: () => new Date('2026-10-20T00:00:00Z') }, now), false);
  assert.equal(isImageExpired(null, now), true);
});

test('assertSendable: plantilla con imagen sin imagen o vencida', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  assert.throws(() => assertSendable({ templateHasImage: true, headerImage: null }, { publicBaseUrl: 'x', now }), is400(/imagen/));
  assert.throws(() => assertSendable({ templateHasImage: true, headerImage: { mediaId: 'M', uploadedAt: new Date('2026-09-01') } }, { publicBaseUrl: 'x', now }), is400(/Volvé a subir la imagen/));
  assert.doesNotThrow(() => assertSendable({ templateHasImage: true, headerImage: { mediaId: 'M', uploadedAt: new Date('2026-10-29') } }, { publicBaseUrl: 'x', now }));
});

test('assertSendable: botón sin PUBLIC_BASE_URL', () => {
  assert.throws(() => assertSendable({ linkMode: 'button' }, { publicBaseUrl: null, now: new Date() }), is400(/PUBLIC_BASE_URL/));
});

test('assertSendable: campaña legacy pasa', () => {
  assert.doesNotThrow(() => assertSendable({ paramsTemplate: [] }, { publicBaseUrl: null, now: new Date() }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/campaignMessage.test.js`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implement `campaignMessage.js`**

```js
import { toMetaBody, resolveVars } from './templateVars.js';

// Lógica pura de difusiones (validación del composer y armado del mensaje
// por destinatario) separada de campaign.service.js para poder testearla
// sin Firestore ni Meta.

const LINK_MODES = new Set(['button', 'text', 'none']);
const IMAGE_MAX_AGE_DAYS = 29; // el media id de Meta vence a los 30 días

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

export function validateComposer({ templateName, bodyText, linkMode, buttonText, targetUrl, publicBaseUrl }) {
  if (!/^[a-z0-9_]{1,512}$/.test(templateName ?? '')) {
    throw badRequest('El nombre técnico de la plantilla sólo puede tener minúsculas, números y _');
  }
  if (!LINK_MODES.has(linkMode)) throw badRequest('Modo de link inválido');
  const { body, order } = toMetaBody(bodyText);
  const usesLink = order.includes('link');
  if (linkMode === 'text' && !usesLink) {
    throw badRequest('Con el link "En el texto" tenés que insertar {{link}} en el mensaje');
  }
  if (linkMode !== 'text' && usesLink) {
    throw badRequest('Sacá {{link}} del texto, o elegí mostrar el link "En el texto"');
  }
  if (linkMode !== 'none' && !/^https?:\/\/\S+$/i.test(targetUrl?.trim() ?? '')) {
    throw badRequest('Cargá la URL destino del link (https://…)');
  }
  if (linkMode === 'button') {
    if (!publicBaseUrl) throw badRequest('El botón necesita PUBLIC_BASE_URL configurada en el servidor');
    const len = buttonText?.trim().length ?? 0;
    if (len < 1 || len > 25) throw badRequest('El texto del botón tiene que tener entre 1 y 25 caracteres');
  }
  return { body, order };
}

/** Comportamiento original de campaign.service.js para campañas creadas
    antes de las plantillas inline — no tocar el formato (p.ej. gastado sin "$"). */
export function legacyInterpolate(template, contact, link) {
  return (template ?? '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, contact.contactName || 'Cliente')
    .replace(/\{\{\s*link\s*\}\}/gi, link ?? '')
    .replace(/\{\{\s*pedidos\s*\}\}/gi, String(contact.tnOrderCount ?? 0))
    .replace(/\{\{\s*gastado\s*\}\}/gi, contact.tnTotalSpent != null ? String(Math.round(contact.tnTotalSpent)) : '0');
}

export function buildRecipientMessage({ campaign, contact, link, shortCode }) {
  const params = Array.isArray(campaign.varOrder)
    ? resolveVars(campaign.varOrder, contact, link)
    : (campaign.paramsTemplate ?? []).map(tpl => legacyInterpolate(tpl, contact, link));
  return {
    params,
    urlButtonParam: campaign.linkMode === 'button' ? shortCode : null,
    headerImageId: campaign.headerImage?.mediaId ?? null,
  };
}

export function isImageExpired(uploadedAt, now = new Date()) {
  if (!uploadedAt) return true;
  const d = typeof uploadedAt.toDate === 'function' ? uploadedAt.toDate() : new Date(uploadedAt);
  return now.getTime() - d.getTime() > IMAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

export function assertSendable(campaign, { publicBaseUrl, now = new Date() }) {
  if (campaign.templateHasImage) {
    if (!campaign.headerImage?.mediaId) throw badRequest('Esta plantilla lleva imagen: subila antes de enviar');
    if (isImageExpired(campaign.headerImage.uploadedAt, now)) {
      throw badRequest('La imagen venció en Meta (más de 29 días). Volvé a subir la imagen.');
    }
  }
  if (campaign.linkMode === 'button' && !publicBaseUrl) {
    throw badRequest('El botón necesita PUBLIC_BASE_URL configurada en el servidor');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/campaignMessage.test.js`
Expected: PASS (16 tests)

- [ ] **Step 5: Update `campaign.service.js`**

Imports (arriba del archivo) quedan:

```js
import crypto from 'crypto';
import admin from 'firebase-admin';
import { getDb } from './firebase.service.js';
import { listCustomers } from './customer.service.js';
import { getOrCreateConversation, appendMessage, updateMessageStatus } from './conversation.service.js';
import { sendWhatsAppTemplate, uploadMetaMedia, uploadTemplateSampleImage, ensureWhatsAppImageSize } from './meta.service.js';
import { createTemplate, syncTemplateStatus } from './template.service.js';
import { TEMPLATE_VARS, sampleValues } from './templateVars.js';
import { validateComposer, buildRecipientMessage, assertSendable } from './campaignMessage.js';
import { toWaContactId } from './phone.js';
```

Reemplazar `createCampaign` por una versión que arma el doc con un helper compartido:

```js
const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));

function buildCampaignDoc({ name, templateName, language, category, paramsTemplate, targetUrl, segment, createdBy,
  varOrder = null, linkMode = null, templateHasImage = false, headerImage = null, status = 'draft', templateStatus = 'APPROVED' }) {
  return {
    name: name.trim(),
    templateName: templateName.trim(),
    language: language || 'es_AR',
    category: category ?? null,
    paramsTemplate: Array.isArray(paramsTemplate) ? paramsTemplate : [],
    varOrder: Array.isArray(varOrder) ? varOrder : null,
    linkMode: linkMode ?? null,
    templateHasImage: !!templateHasImage,
    headerImage,
    templateStatus,
    templateRejectedReason: null,
    targetUrl: targetUrl?.trim() || null,
    segment: {
      q: segment?.q ?? null,
      channel: segment?.channel ?? null,
      tags: segment?.tags ?? [],
      hasOrders: !!segment?.hasOrders,
      spentMin: num(segment?.spentMin),
      spentMonths: num(segment?.spentMonths) ?? 12,
      product: segment?.product?.trim() || null,
      productMonths: num(segment?.productMonths) ?? 12,
      orderCountMin: num(segment?.orderCountMin),
      lastOrderMaxDays: num(segment?.lastOrderMaxDays),
      lastOrderMinDays: num(segment?.lastOrderMinDays),
    },
    status,
    createdBy: createdBy ?? null,
    createdAt: new Date(),
    sentAt: null,
    stats: { total: 0, sent: 0, failed: 0, delivered: 0, read: 0, clicked: 0 },
  };
}

export async function createCampaign(input) {
  if (!input.name?.trim() || !input.templateName?.trim()) {
    const e = new Error('name y templateName son requeridos');
    e.status = 400;
    throw e;
  }
  const doc = buildCampaignDoc(input);
  const ref = await getDb().collection(CAMPAIGNS).add(doc);
  return { id: ref.id, ...doc };
}

async function prepareImage(file) {
  if (!file) return null;
  const { buffer, mimeType } = await ensureWhatsAppImageSize(file.buffer, file.mimetype);
  return { buffer, mimeType };
}

/** Difusión + plantilla nueva en un solo paso. Si Meta rechaza la plantilla
    no se crea nada (createTemplate strict) y el error vuelve al formulario. */
export async function createCampaignWithTemplate({ data, imageFile, publicBaseUrl, createdBy }) {
  const { name, templateName, category, bodyText, linkMode, buttonText, targetUrl, segment } = data ?? {};
  if (!name?.trim()) { const e = new Error('El nombre de la difusión es obligatorio'); e.status = 400; throw e; }
  const { body, order } = validateComposer({ templateName, bodyText, linkMode, buttonText, targetUrl, publicBaseUrl });

  const image = await prepareImage(imageFile);
  let handle = null;
  let mediaId = null;
  if (image) {
    handle = await uploadTemplateSampleImage(image.buffer, image.mimeType);
    mediaId = await uploadMetaMedia(image.buffer, image.mimeType);
  }

  const labels = Object.fromEntries(TEMPLATE_VARS.map(v => [v.key, v.label]));
  const tpl = await createTemplate({
    name: templateName,
    displayName: name,
    bodyText: body,
    language: 'es_AR',
    category: category === 'UTILITY' ? 'UTILITY' : 'MARKETING',
    params: order.map(k => labels[k]),
    bodyExamples: sampleValues(order),
    header: handle ? { format: 'IMAGE', handle } : null,
    button: linkMode === 'button' ? { text: buttonText.trim(), urlBase: publicBaseUrl } : null,
    varOrder: order,
    linkMode,
    strict: true,
  });

  const approved = tpl.metaStatus === 'APPROVED';
  return createCampaign({
    name, templateName, language: 'es_AR', category: tpl.category,
    paramsTemplate: [], varOrder: order, linkMode,
    targetUrl: linkMode === 'none' ? null : targetUrl,
    segment, createdBy,
    templateHasImage: !!handle,
    headerImage: mediaId ? { mediaId, uploadedAt: new Date() } : null,
    status: approved ? 'draft' : 'pending_template',
    templateStatus: tpl.metaStatus,
  });
}

export async function setCampaignImage(campaignId, imageFile) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) { const e = new Error('Campaña no encontrada'); e.status = 404; throw e; }
  if (!['draft', 'pending_template'].includes(campaign.status)) {
    const e = new Error('Sólo se puede cambiar la imagen antes de enviar'); e.status = 409; throw e;
  }
  if (!imageFile) { const e = new Error('No se recibió la imagen'); e.status = 400; throw e; }
  const image = await prepareImage(imageFile);
  const mediaId = await uploadMetaMedia(image.buffer, image.mimeType);
  const headerImage = { mediaId, uploadedAt: new Date() };
  await getDb().collection(CAMPAIGNS).doc(campaignId).update({ headerImage });
  return { ...campaign, headerImage };
}

export async function refreshTemplateStatus(campaignId) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) { const e = new Error('Campaña no encontrada'); e.status = 404; throw e; }
  if (campaign.status !== 'pending_template') return campaign;
  const { status, rejectedReason } = await syncTemplateStatus(campaign.templateName, campaign.language);
  const update = {};
  if (status === 'APPROVED') Object.assign(update, { status: 'draft', templateStatus: status });
  else if (status === 'REJECTED') Object.assign(update, { status: 'template_rejected', templateStatus: status, templateRejectedReason: rejectedReason ?? null });
  if (Object.keys(update).length === 0) return campaign;
  await getDb().collection(CAMPAIGNS).doc(campaignId).update(update);
  return { ...campaign, ...update };
}
```

Borrar la función `interpolate` de `campaign.service.js` (ahora vive como `legacyInterpolate` en `campaignMessage.js`).

En `sendCampaign`, después del chequeo `campaign.status !== 'draft'`, agregar:

```js
  assertSendable(campaign, { publicBaseUrl });
```

y dentro del loop reemplazar desde `let shortCode = null;` hasta la llamada a `sendWhatsAppTemplate` por:

```js
        let shortCode = null;
        let link = campaign.targetUrl;
        // linkMode null = campaña legacy: se comporta como antes (link si hay targetUrl)
        if (campaign.targetUrl && publicBaseUrl && campaign.linkMode !== 'none') {
          shortCode = await createShortLink({ targetUrl: campaign.targetUrl, campaignId, contactId: contact.contactId });
          link = `${publicBaseUrl}/r/${shortCode}`;
        }
        const { params, urlButtonParam, headerImageId } = buildRecipientMessage({ campaign, contact, link, shortCode });

        await getOrCreateConversation(contact.contactId, 'whatsapp', contact.contactName);
        const msgId = crypto.randomUUID();
        const prefix = `[Difusión: ${campaign.templateName}]${headerImageId ? ' [Imagen]' : ''}`;
        const templateText = params.filter(Boolean).length > 0 ? `${prefix} ${params.join(' | ')}` : prefix;
        await appendMessage(contact.contactId, { role: 'admin', content: templateText, msgId, msgStatus: 'sending', sentBy: campaign.createdBy });

        let sendError = null;
        let waMsgId = null;
        try {
          waMsgId = await sendWhatsAppTemplate(contact.contactId, campaign.templateName, campaign.language, params, urlButtonParam, headerImageId);
        } catch (err) {
          sendError = err.response?.data?.error?.message ?? err.message;
        }
```

(el resto del loop — `updateMessageStatus`, `SENDS`, stats — queda igual.)

- [ ] **Step 6: Update `campaign.routes.js`**

Imports y multer:

```js
import { Router } from 'express';
import multer from 'multer';
import {
  listCampaigns,
  getCampaign,
  getCampaignSends,
  createCampaign,
  createCampaignWithTemplate,
  setCampaignImage,
  refreshTemplateStatus,
  deleteCampaign,
  sendCampaign,
  resolveSegment,
} from '../services/campaign.service.js';

const router = Router();
// 16MB como en conversation.routes.js: la foto se recomprime a ≤5MB después.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});
const publicBaseUrl = () => process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || null;
```

Rutas nuevas, **antes** de `router.get('/:id', …)`:

```js
router.get('/meta-info', (req, res) => {
  res.json({ canUseButton: !!publicBaseUrl() });
});

router.post('/with-template', upload.single('image'), async (req, res) => {
  try {
    let data;
    try { data = JSON.parse(req.body.data ?? '{}'); } catch { return res.status(400).json({ error: 'Datos inválidos' }); }
    const campaign = await createCampaignWithTemplate({
      data, imageFile: req.file ?? null, publicBaseUrl: publicBaseUrl(), createdBy: req.agent?.email ?? null,
    });
    res.status(201).json({ campaign });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});
```

El `POST /` existente pasa los campos nuevos:

```js
router.post('/', async (req, res) => {
  try {
    const { name, templateName, language, category, paramsTemplate, targetUrl, segment, varOrder, linkMode, templateHasImage } = req.body;
    const campaign = await createCampaign({
      name, templateName, language, category, paramsTemplate, targetUrl, segment, varOrder, linkMode, templateHasImage,
      createdBy: req.agent?.email ?? null,
    });
    res.status(201).json({ campaign });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});
```

Rutas por id, después de `router.get('/:id', …)`:

```js
router.post('/:id/image', upload.single('image'), async (req, res) => {
  try {
    res.json({ campaign: await setCampaignImage(req.params.id, req.file ?? null) });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.get('/:id/template-status', async (req, res) => {
  try {
    res.json({ campaign: await refreshTemplateStatus(req.params.id) });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});
```

Y en `POST /:id/send` usar `publicBaseUrl()` en vez de la expresión inline.

- [ ] **Step 7: Run all tests + smoke import**

Run: `cd server && npm test && node -e "import('./src/routes/campaign.routes.js').then(()=>console.log('ok'))"`
Expected: PASS y `ok` (si el import falla por variables de Firebase, alcanza con que el error NO sea de sintaxis/import faltante).

- [ ] **Step 8: Commit**

```bash
git add server/src/services/campaignMessage.js server/src/services/campaignMessage.test.js server/src/services/campaign.service.js server/src/routes/campaign.routes.js
git commit -m "feat(campaigns): crear difusión con plantilla nueva, imagen y link por botón o texto"
```

---

### Task 5: Utils del client — datos insertables, nombre técnico y costo

**Files:**
- Create: `client/src/utils/templateVars.js`, `client/src/utils/templateVars.test.js`
- Create: `client/src/utils/costEstimate.js`, `client/src/utils/costEstimate.test.js`
- Modify: `client/package.json` (script `"test": "node --test \"src/utils/*.test.js\""`)

**Interfaces:**
- Produces:
  - `TEMPLATE_VARS: Array<{ key, label, sample }>` (mismas claves que el backend)
  - `slugTemplateName(name: string, date = new Date()) => string`
  - `renderPreview(text: string, contactName?: string|null) => string`
  - `estimateCost({ count, category, pricing }) => { rate, usd, ars } | { missingRate: true }`
  - `formatUsd(n) => string`, `formatArs(n) => string`

- [ ] **Step 1: Write the failing tests**

`client/src/utils/templateVars.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATE_VARS, slugTemplateName, renderPreview } from './templateVars.js';

test('slugTemplateName: minúsculas, sin acentos, _ y sufijo MMDD', () => {
  assert.equal(slugTemplateName('Promo Día del Padre!', new Date(2026, 8, 25)), 'promo_dia_del_padre_0925');
  assert.equal(slugTemplateName('  ', new Date(2026, 0, 5)), 'difusion_0105');
});

test('renderPreview usa el nombre del contacto de muestra y samples', () => {
  assert.equal(
    renderPreview('Hola {{primer_nombre}} ({{nombre}}), gastaste {{gastado}}. {{link}}', 'Ana María López'),
    'Hola Ana (Ana María López), gastaste $ 45.000. https://altorancho.com.ar',
  );
  assert.equal(renderPreview('Hola {{ primer_nombre }}.', null), 'Hola Juan.');
});

test('renderPreview deja los tokens desconocidos a la vista', () => {
  assert.equal(renderPreview('Hola {{apellido}}.', 'Ana'), 'Hola {{apellido}}.');
});

test('claves iguales al backend', () => {
  assert.deepEqual(TEMPLATE_VARS.map(v => v.key), ['nombre', 'primer_nombre', 'pedidos', 'gastado', 'ultimo_pedido', 'link']);
});
```

`client/src/utils/costEstimate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, formatUsd, formatArs } from './costEstimate.js';

test('multiplica contactos por la tarifa de la categoría', () => {
  const r = estimateCost({ count: 1240, category: 'MARKETING', pricing: { marketing: 0.0618, utility: 0.026, arsRate: 1200 } });
  assert.equal(r.rate, 0.0618);
  assert.ok(Math.abs(r.usd - 76.632) < 1e-9);
  assert.ok(Math.abs(r.ars - 91958.4) < 1e-6);
});

test('utilidad usa su tarifa; sin cotización ars es null', () => {
  const r = estimateCost({ count: 10, category: 'UTILITY', pricing: { marketing: 0.06, utility: 0.02, arsRate: null } });
  assert.ok(Math.abs(r.usd - 0.2) < 1e-9);
  assert.equal(r.ars, null);
});

test('sin tarifa cargada', () => {
  assert.deepEqual(estimateCost({ count: 10, category: 'MARKETING', pricing: {} }), { missingRate: true });
  assert.deepEqual(estimateCost({ count: 10, category: 'MARKETING', pricing: undefined }), { missingRate: true });
});

test('formatos', () => {
  assert.equal(formatUsd(76.632), 'USD 76,63');
  assert.equal(formatUsd(0.0618), 'USD 0,0618');
  assert.equal(formatArs(91958.4), '$ 91.958');
});
```

- [ ] **Step 2: Add test script and run to verify failure**

En `client/package.json`, dentro de `"scripts"`: `"test": "node --test \"src/utils/*.test.js\""`.

Run: `cd client && npm test`
Expected: FAIL — módulos no existen.

- [ ] **Step 3: Implement**

`client/src/utils/templateVars.js`:

```js
// Espejo (sólo para la UI) de server/src/services/templateVars.js — la
// resolución real por contacto la hace el backend al enviar.
export const TEMPLATE_VARS = [
  { key: 'nombre', label: 'Nombre completo', sample: 'Juan Pérez' },
  { key: 'primer_nombre', label: 'Primer nombre', sample: 'Juan' },
  { key: 'pedidos', label: 'Cantidad de pedidos', sample: '3' },
  { key: 'gastado', label: 'Total gastado', sample: '$ 45.000' },
  { key: 'ultimo_pedido', label: 'Fecha del último pedido', sample: '12/09/2026' },
  { key: 'link', label: 'Link de la promo', sample: 'https://altorancho.com.ar' },
];

const SAMPLES = Object.fromEntries(TEMPLATE_VARS.map(v => [v.key, v.sample]));

export function slugTemplateName(name, date = new Date()) {
  const base = (name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'difusion';
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `${base}_${mmdd}`;
}

export function renderPreview(text, contactName = null) {
  const full = contactName?.trim() || null;
  const values = { ...SAMPLES };
  if (full) {
    values.nombre = full;
    values.primer_nombre = full.split(/\s+/)[0];
  }
  return (text ?? '').replace(/\{\{\s*([^}]*?)\s*\}\}/g, (m, raw) => values[raw.toLowerCase()] ?? m);
}
```

`client/src/utils/costEstimate.js`:

```js
// Meta cobra por plantilla entregada según categoría. Es una estimación:
// asume que se entregan todos los mensajes del segmento.
export function estimateCost({ count, category, pricing }) {
  const rate = category === 'UTILITY' ? pricing?.utility : pricing?.marketing;
  if (rate === null || rate === undefined || rate === '' || isNaN(Number(rate))) return { missingRate: true };
  const usd = Number(count ?? 0) * Number(rate);
  const arsRate = pricing?.arsRate;
  const ars = arsRate === null || arsRate === undefined || arsRate === '' || isNaN(Number(arsRate)) ? null : usd * Number(arsRate);
  return { rate: Number(rate), usd, ars };
}

export function formatUsd(n) {
  const digits = Math.abs(n) < 1 && n !== 0 ? 4 : 2;
  return `USD ${Number(n).toFixed(digits).replace('.', ',')}`;
}

export function formatArs(n) {
  return `$ ${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}
```

- [ ] **Step 4: Run tests**

Run: `cd client && npm test`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add client/package.json client/src/utils/templateVars.js client/src/utils/templateVars.test.js client/src/utils/costEstimate.js client/src/utils/costEstimate.test.js
git commit -m "feat(campaigns): utils de preview, nombre técnico y estimación de costo"
```

---

### Task 6: UI de Difusiones — composer, preview, costo, estados nuevos

**Files:**
- Create: `client/src/components/Campaigns/TemplateComposer.jsx`
- Create: `client/src/components/Campaigns/WhatsAppPreview.jsx`
- Create: `client/src/components/Campaigns/CostEstimate.jsx`
- Create: `client/src/components/Campaigns/Composer.module.css`
- Modify: `client/src/pages/Campaigns.jsx`, `client/src/pages/Campaigns.module.css`

**Interfaces:**
- Consumes: HTTP de Task 4; `TEMPLATE_VARS`, `slugTemplateName`, `renderPreview`, `estimateCost`, `formatUsd`, `formatArs` (Task 5); `GET /api/config` → `{ config: { pricing } }` (Task 7 lo escribe; si no existe → "Cargá la tarifa en Config").
- Produces:
  - `<TemplateComposer value onChange canUseButton campaignName />` — `value = { templateName, templateNameTouched, category, bodyText, imageFile, linkMode, buttonText }`
  - `<WhatsAppPreview imageUrl text buttonText />`
  - `<CostEstimate count category pricing />`

- [ ] **Step 1: `Composer.module.css`**

```css
.composer { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.row { display: flex; gap: var(--space-3); flex-wrap: wrap; }
.row > * { flex: 1 1 200px; }
.label { font-size: var(--font-size-sm); color: var(--color-text); font-weight: 600; }
.input { width: 100%; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font: inherit; background: var(--color-surface); color: var(--color-text); }
.textarea { composes: input; min-height: 110px; resize: vertical; }
.hint { font-size: var(--font-size-xs); color: var(--color-text-muted); margin: 0; }
.varBar { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.varChip { border: 1px dashed var(--color-border); background: var(--color-surface-alt); color: var(--color-text); border-radius: 999px; padding: 2px 10px; font-size: var(--font-size-xs); cursor: pointer; }
.varChip:hover { border-color: var(--color-primary); }
.varChip:disabled { opacity: .45; cursor: not-allowed; }
.segmented { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.segBtn { border: 1px solid var(--color-border); background: var(--color-surface); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-3); font-size: var(--font-size-sm); cursor: pointer; color: var(--color-text); }
.segBtnActive { border-color: var(--color-primary); color: var(--color-primary); font-weight: 600; }
.segBtn:disabled { opacity: .45; cursor: not-allowed; }

.phone { background: #e5ddd5; border-radius: var(--radius-lg); padding: var(--space-4); max-width: 340px; }
.bubble { background: #fff; color: #111; border-radius: 8px; box-shadow: var(--shadow-xs); overflow: hidden; }
.bubbleImg { display: block; width: 100%; max-height: 220px; object-fit: cover; }
.bubbleText { padding: var(--space-2) var(--space-3); white-space: pre-wrap; font-size: 14px; line-height: 1.4; }
.bubbleBtn { border-top: 1px solid #e5e5e5; text-align: center; padding: var(--space-2); color: #0a7cff; font-size: 14px; }

.cost { font-size: var(--font-size-sm); color: var(--color-text); margin: 0; }
.costNote { font-size: var(--font-size-xs); color: var(--color-text-muted); margin: 0; }
```

- [ ] **Step 2: `WhatsAppPreview.jsx`**

```jsx
import styles from './Composer.module.css';

export default function WhatsAppPreview({ imageUrl, text, buttonText }) {
  return (
    <div className={styles.phone}>
      <div className={styles.bubble}>
        {imageUrl && <img className={styles.bubbleImg} src={imageUrl} alt="" />}
        <div className={styles.bubbleText}>{text || 'Escribí el mensaje…'}</div>
        {buttonText && <div className={styles.bubbleBtn}>↗ {buttonText}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `CostEstimate.jsx`**

```jsx
import { estimateCost, formatUsd, formatArs } from '../../utils/costEstimate';
import styles from './Composer.module.css';

const CATEGORY_LABEL = { MARKETING: 'Marketing', UTILITY: 'Utilidad' };

export default function CostEstimate({ count, category, pricing }) {
  if (!category) return null;
  const r = estimateCost({ count, category, pricing });
  return (
    <div>
      {r.missingRate ? (
        <p className={styles.cost}>💲 Cargá la tarifa de {CATEGORY_LABEL[category] ?? category} en Config para ver el costo estimado.</p>
      ) : (
        <p className={styles.cost}>
          💲 {count ?? 0} contactos de WhatsApp × {formatUsd(r.rate)} ({CATEGORY_LABEL[category] ?? category}) ≈ <strong>{formatUsd(r.usd)}</strong>
          {r.ars !== null && <> (≈ {formatArs(r.ars)})</>}
        </p>
      )}
      <p className={styles.costNote}>Estimado. Meta cobra sólo los mensajes entregados; las tarifas se editan en Config.</p>
    </div>
  );
}
```

- [ ] **Step 4: `TemplateComposer.jsx`**

```jsx
import { useEffect, useMemo, useRef } from 'react';
import { TEMPLATE_VARS, slugTemplateName } from '../../utils/templateVars';
import styles from './Composer.module.css';

export const EMPTY_COMPOSER = {
  templateName: '', templateNameTouched: false, category: 'MARKETING',
  bodyText: '', imageFile: null, linkMode: 'button', buttonText: 'Ver promo',
};

export default function TemplateComposer({ value, onChange, canUseButton, campaignName }) {
  const textRef = useRef(null);
  const set = (patch) => onChange({ ...value, ...patch });

  // El nombre técnico sigue al nombre de la difusión hasta que lo editan a mano
  useEffect(() => {
    if (!value.templateNameTouched) set({ templateName: slugTemplateName(campaignName) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignName]);

  useEffect(() => {
    if (!canUseButton && value.linkMode === 'button') set({ linkMode: 'text' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseButton]);

  function insertVar(key) {
    const el = textRef.current;
    const token = `{{${key}}}`;
    const start = el?.selectionStart ?? value.bodyText.length;
    const end = el?.selectionEnd ?? value.bodyText.length;
    const bodyText = value.bodyText.slice(0, start) + token + value.bodyText.slice(end);
    set({ bodyText });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
  }

  const vars = useMemo(() => TEMPLATE_VARS, []);

  return (
    <div className={styles.composer}>
      <div className={styles.row}>
        <div>
          <label className={styles.label}>Nombre técnico de la plantilla</label>
          <input
            className={styles.input}
            value={value.templateName}
            onChange={e => set({ templateName: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'), templateNameTouched: true })}
            required
          />
        </div>
        <div>
          <label className={styles.label}>Categoría</label>
          <select className={styles.input} value={value.category} onChange={e => set({ category: e.target.value })}>
            <option value="MARKETING">Marketing (promos)</option>
            <option value="UTILITY">Utilidad (avisos)</option>
          </select>
        </div>
      </div>

      <div>
        <label className={styles.label}>Imagen (opcional)</label>
        <input type="file" accept="image/*" onChange={e => set({ imageFile: e.target.files?.[0] ?? null })} />
      </div>

      <div>
        <label className={styles.label}>Texto del mensaje</label>
        <div className={styles.varBar}>
          <span className={styles.hint}>+ Insertar dato:</span>
          {vars.map(v => (
            <button
              key={v.key}
              type="button"
              className={styles.varChip}
              onClick={() => insertVar(v.key)}
              disabled={v.key === 'link' && value.linkMode !== 'text'}
              title={v.key === 'link' && value.linkMode !== 'text' ? 'Sólo con el link "En el texto"' : ''}
            >
              {v.label}
            </button>
          ))}
        </div>
        <textarea
          ref={textRef}
          className={styles.textarea}
          value={value.bodyText}
          onChange={e => set({ bodyText: e.target.value })}
          placeholder="Hola {{primer_nombre}}! Esta semana tenemos 20% off en toda la tienda."
          required
        />
        <p className={styles.hint}>No empieces ni termines el texto con un dato (Meta lo rechaza).</p>
      </div>

      <div>
        <label className={styles.label}>Link</label>
        <div className={styles.segmented}>
          {[['button', 'Botón abajo'], ['text', 'En el texto'], ['none', 'Sin link']].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`${styles.segBtn} ${value.linkMode === mode ? styles.segBtnActive : ''}`}
              onClick={() => set({ linkMode: mode })}
              disabled={mode === 'button' && !canUseButton}
            >
              {label}
            </button>
          ))}
        </div>
        {!canUseButton && <p className={styles.hint}>El botón necesita PUBLIC_BASE_URL configurada en el servidor.</p>}
        {value.linkMode === 'button' && (
          <input
            className={styles.input}
            maxLength={25}
            value={value.buttonText}
            onChange={e => set({ buttonText: e.target.value })}
            placeholder="Ver promo"
            required
          />
        )}
        {value.linkMode === 'text' && <p className={styles.hint}>Insertá "Link de la promo" en el texto donde quieras que aparezca.</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Integrar en `Campaigns.jsx`**

Cambios (sobre el archivo actual):

a) Imports y constantes:

```jsx
import TemplateComposer, { EMPTY_COMPOSER } from '../components/Campaigns/TemplateComposer';
import WhatsAppPreview from '../components/Campaigns/WhatsAppPreview';
import CostEstimate from '../components/Campaigns/CostEstimate';
import { renderPreview } from '../utils/templateVars';

const STATUS_LABEL = { pending_template: 'Esperando aprobación', template_rejected: 'Plantilla rechazada', draft: 'Borrador', sending: 'Enviando…', sent: 'Enviada' };
const STATUS_CLASS = { pending_template: 'statusSending', template_rejected: 'statusRejected', draft: 'statusDraft', sending: 'statusSending', sent: 'statusSent' };
const DEFAULT_FORM = { name: '', mode: 'existing', templateId: '', targetUrl: '', segment: { ...EMPTY_SEGMENT } };
const DELETABLE = new Set(['draft', 'pending_template', 'template_rejected']);
```

b) Estado nuevo en el componente:

```jsx
  const [composer, setComposer] = useState(EMPTY_COMPOSER);
  const [imageFile, setImageFile] = useState(null); // para plantillas aprobadas con header IMAGE
  const [pricing, setPricing] = useState(null);
  const [canUseButton, setCanUseButton] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
```

c) En `load`, sumar al `Promise.all` `authFetch(BASE_URL + '/api/config')` y `authFetch(BASE_URL + '/api/campaigns/meta-info')`:

```jsx
      const [campRes, tplRes, tagsRes, cfgRes, infoRes] = await Promise.all([
        authFetch(BASE_URL + '/api/campaigns'),
        authFetch(BASE_URL + '/api/templates'),
        authFetch(BASE_URL + '/api/customers/tags'),
        authFetch(BASE_URL + '/api/config'),
        authFetch(BASE_URL + '/api/campaigns/meta-info'),
      ]);
      ...
      if (cfgRes.ok) setPricing((await cfgRes.json()).config?.pricing ?? null);
      if (infoRes.ok) setCanUseButton(!!(await infoRes.json()).canUseButton);
```

d) `openCreate` resetea también `setComposer(EMPTY_COMPOSER); setImageFile(null);`.

e) URL de preview de la imagen (composer o plantilla aprobada):

```jsx
  const activeImage = form?.mode === 'new' ? composer.imageFile : imageFile;
  useEffect(() => {
    if (!activeImage) { setImagePreviewUrl(null); return; }
    const url = URL.createObjectURL(activeImage);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [activeImage]);
```

f) `handleCreate` reemplazado por:

```jsx
  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      let campaign;
      if (form.mode === 'new') {
        const fd = new FormData();
        fd.append('data', JSON.stringify({
          name: form.name,
          templateName: composer.templateName,
          category: composer.category,
          bodyText: composer.bodyText,
          linkMode: composer.linkMode,
          buttonText: composer.buttonText,
          targetUrl: form.targetUrl,
          segment: form.segment,
        }));
        if (composer.imageFile) fd.append('image', composer.imageFile);
        const res = await authFetch(BASE_URL + '/api/campaigns/with-template', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        campaign = data.campaign;
      } else {
        if (!selectedTemplate) throw new Error('Elegí una plantilla aprobada');
        const needsImage = selectedTemplate.headerFormat === 'IMAGE';
        if (needsImage && !imageFile) throw new Error('Esta plantilla lleva imagen: subila');
        const res = await authFetch(BASE_URL + '/api/campaigns', {
          method: 'POST',
          body: {
            name: form.name,
            templateName: selectedTemplate.name,
            language: selectedTemplate.language,
            category: selectedTemplate.category,
            paramsTemplate: selectedTemplate.varOrder ? [] : params,
            varOrder: selectedTemplate.varOrder ?? null,
            linkMode: selectedTemplate.linkMode ?? null,
            templateHasImage: needsImage,
            targetUrl: form.targetUrl,
            segment: form.segment,
          },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        campaign = data.campaign;
        if (needsImage) {
          const fd = new FormData();
          fd.append('image', imageFile);
          const imgRes = await authFetch(BASE_URL + `/api/campaigns/${campaign.id}/image`, { method: 'POST', body: fd });
          const imgData = await imgRes.json();
          if (!imgRes.ok) throw new Error(`La difusión se creó pero falló la imagen: ${imgData.error}`);
        }
      }
      setForm(null);
      await load();
      openDetail(campaign);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
```

g) Polling de aprobación — agregar otro `useEffect` junto al existente:

```jsx
  const tplPollRef = useRef(null);
  useEffect(() => {
    clearInterval(tplPollRef.current);
    if (detail?.campaign?.status === 'pending_template') {
      tplPollRef.current = setInterval(async () => {
        const res = await authFetch(BASE_URL + `/api/campaigns/${detail.campaign.id}/template-status`);
        if (res.ok) {
          const { campaign } = await res.json();
          if (campaign.status !== 'pending_template') {
            setDetail(prev => ({ ...prev, campaign }));
            setCampaigns(prev => prev.map(c => c.id === campaign.id ? campaign : c));
          }
        }
      }, 10000);
    }
    return () => clearInterval(tplPollRef.current);
  }, [detail?.campaign?.status, detail?.campaign?.id]);

  async function handleChangeImage(file) {
    if (!file || !detail) return;
    const fd = new FormData();
    fd.append('image', file);
    const res = await authFetch(BASE_URL + `/api/campaigns/${detail.campaign.id}/image`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { alert(`No se pudo subir la imagen: ${data.error}`); return; }
    setDetail(prev => ({ ...prev, campaign: data.campaign }));
  }
```

h) JSX del formulario: reemplazar el bloque `Plantilla aprobada` + `Parámetros` + `Link a trackear` por:

```jsx
            <div className={styles.field}>
              <label className={styles.label}>Mensaje</label>
              <div className={styles.modeSwitch}>
                <button type="button" className={`${styles.tagChip} ${form.mode === 'existing' ? styles.tagChipActive : ''}`} onClick={() => setField('mode', 'existing')}>Usar plantilla aprobada</button>
                <button type="button" className={`${styles.tagChip} ${form.mode === 'new' ? styles.tagChipActive : ''}`} onClick={() => setField('mode', 'new')}>Crear plantilla nueva</button>
              </div>
            </div>

            <div className={styles.composeGrid}>
              <div className={styles.composeMain}>
                {form.mode === 'new' ? (
                  <TemplateComposer value={composer} onChange={setComposer} canUseButton={canUseButton} campaignName={form.name} />
                ) : (
                  <>
                    {/* bloque existente "Plantilla aprobada" (select + templatePreview) tal cual */}
                    {selectedTemplate?.headerFormat === 'IMAGE' && (
                      <div className={styles.field}>
                        <label className={styles.label}>Imagen de esta difusión</label>
                        <input type="file" accept="image/*" onChange={e => setImageFile(e.target.files?.[0] ?? null)} required />
                      </div>
                    )}
                    {/* bloque existente "Parámetros de la plantilla", ahora con condición:
                        selectedTemplate?.params?.length > 0 && !selectedTemplate.varOrder */}
                  </>
                )}

                {(form.mode === 'new' ? composer.linkMode !== 'none' : true) && (
                  <div className={styles.field}>
                    <label className={styles.label}>{form.mode === 'new' ? 'URL destino del link' : 'Link a trackear (opcional)'}</label>
                    <input className={styles.input} type="url" value={form.targetUrl} onChange={e => setField('targetUrl', e.target.value)} placeholder="https://..." required={form.mode === 'new'} />
                    <p className={styles.hint}>Cada contacto recibe un link corto propio para poder contar los clicks.</p>
                  </div>
                )}
              </div>

              <WhatsAppPreview
                imageUrl={imagePreviewUrl}
                text={renderPreview(form.mode === 'new' ? composer.bodyText : selectedTemplate?.bodyText ?? '', preview?.sample?.[0]?.contactName)}
                buttonText={form.mode === 'new'
                  ? (composer.linkMode === 'button' ? composer.buttonText : null)
                  : (selectedTemplate?.button?.text ?? (selectedTemplate?.hasUrlButton ? 'Link' : null))}
              />
            </div>
```

El select de plantillas existente cambia su `required` a `required={form.mode === 'existing'}`.

i) Debajo de `<p className={styles.previewCount}>…</p>`:

```jsx
              <CostEstimate
                count={preview?.whatsappCount ?? 0}
                category={form.mode === 'new' ? composer.category : selectedTemplate?.category}
                pricing={pricing}
              />
```

j) Botón submit: texto `{saving ? 'Guardando…' : form.mode === 'new' ? 'Guardar y mandar a aprobar' : 'Guardar borrador'}`.

k) Detalle — después de `<div className={styles.statsGrid}>…</div>` y antes del botón Enviar:

```jsx
            {detail.campaign.status === 'pending_template' && (
              <p className={styles.hint}>⏳ Esperando que Meta apruebe la plantilla. Esto se actualiza solo; cuando se apruebe se habilita Enviar.</p>
            )}
            {detail.campaign.status === 'template_rejected' && (
              <p className={styles.error}>Meta rechazó la plantilla{detail.campaign.templateRejectedReason ? `: ${detail.campaign.templateRejectedReason}` : ''}. Borrá esta difusión y creala de nuevo corrigiendo el texto.</p>
            )}
            {detail.campaign.templateHasImage && ['draft', 'pending_template'].includes(detail.campaign.status) && (
              <div className={styles.imageRow}>
                {detail.campaign.headerImage?.mediaId && (
                  <img
                    className={styles.imageThumb}
                    alt=""
                    src={`${BASE_URL}/api/conversations/media/${detail.campaign.headerImage.mediaId}?token=${encodeURIComponent(localStorage.getItem('altorancho_token') ?? '')}`}
                  />
                )}
                <label className={styles.btnSecondary}>
                  Cambiar imagen
                  <input type="file" accept="image/*" hidden onChange={e => handleChangeImage(e.target.files?.[0])} />
                </label>
              </div>
            )}
```

l) Tabla: el botón Eliminar se muestra con `DELETABLE.has(c.status)` en vez de `c.status === 'draft'`.

m) En `Campaigns.module.css` agregar:

```css
.modeSwitch { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.composeGrid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--space-4); align-items: start; }
.composeMain { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
@media (max-width: 900px) { .composeGrid { grid-template-columns: 1fr; } }
.statusRejected { background: var(--color-surface-alt); color: var(--color-error); border: 1px solid var(--color-error); }
.imageRow { display: flex; align-items: center; gap: var(--space-3); }
.imageThumb { width: 96px; height: 96px; object-fit: cover; border-radius: var(--radius-md); border: 1px solid var(--color-border); }
```

- [ ] **Step 6: Build**

Run: `cd client && npm run build`
Expected: build OK sin errores.

- [ ] **Step 7: Verificación visual local**

Run: `cd client && npm run dev` (con `VITE_API_URL` apuntando al backend de prod o local según el `.env` del client) y abrir Difusiones → Nueva difusión:
- Alternar "Usar plantilla aprobada" / "Crear plantilla nueva".
- En nueva: insertar "Primer nombre" en el cursor, cambiar modo de link (el chip "Link de la promo" sólo se habilita en "En el texto"), subir imagen → aparece en la burbuja.
- La línea de costo aparece (o el aviso de cargar tarifa).
- **No** guardar contra prod en este paso.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/Campaigns client/src/pages/Campaigns.jsx client/src/pages/Campaigns.module.css
git commit -m "feat(campaigns): crear plantilla con imagen desde Difusiones, vista previa y costo estimado"
```

---

### Task 7: Tarifas en Config + badges en Plantillas

**Files:**
- Modify: `client/src/pages/Config.jsx` (nueva `<section>` después de la de SimpliRoute, ~línea 158)
- Modify: `client/src/pages/Templates.jsx` (celda de nombre, ~línea 166)

**Interfaces:**
- Produces: `config.pricing = { marketing: number|null, utility: number|null, arsRate: number|null }` guardado por el `PUT /api/config` existente (merge).

- [ ] **Step 1: Sección de tarifas en `Config.jsx`**

Agregar arriba del componente:

```jsx
function toNum(v) { return v === '' ? null : Number(v); }
```

Y la sección, después del bloque `{/* SimpliRoute */}`:

```jsx
        {/* Tarifas WhatsApp */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Tarifas WhatsApp (calculadora de difusiones)</h2>
          <p className={styles.hint}>
            Precio que cobra Meta por cada plantilla entregada en Argentina. Sacalo de la tabla oficial de precios de
            WhatsApp Business y actualizalo cuando Meta lo cambie.
          </p>
          {[
            ['marketing', 'USD por mensaje — Marketing', '0.0001'],
            ['utility', 'USD por mensaje — Utilidad', '0.0001'],
            ['arsRate', 'Cotización (ARS por 1 USD, opcional)', '1'],
          ].map(([key, label, step]) => (
            <div key={key} className={styles.field}>
              <label className={styles.label}>{label}</label>
              <input
                className={styles.input}
                type="number"
                min="0"
                step={step}
                value={config.pricing?.[key] ?? ''}
                onChange={(e) => setConfig({ ...config, pricing: { ...config.pricing, [key]: toNum(e.target.value) } })}
              />
            </div>
          ))}
        </section>
```

(Usar las clases `field`/`label`/`input` que ya existan en `Config.module.css`; si el archivo usa otros nombres para campos, reusar esos — revisar la sección "Mensajes del bot" como referencia.)

- [ ] **Step 2: Badges en `Templates.jsx`**

En la celda del nombre (`<span className={styles.nameBadge}>{t.name}</span>`), agregar a continuación:

```jsx
                      {t.headerFormat === 'IMAGE' && <span className={styles.meta}> · 🖼 Imagen</span>}
                      {t.hasUrlButton && <span className={styles.meta}> · 🔗 Botón</span>}
```

- [ ] **Step 3: Build**

Run: `cd client && npm run build`
Expected: OK.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Config.jsx client/src/pages/Templates.jsx
git commit -m "feat(config): tarifas de WhatsApp para la calculadora + badges de imagen/botón en plantillas"
```

---

### Task 8: Deploy y prueba real (con el usuario)

**Files:** ninguno (verificación).

- [ ] **Step 1: Correr todos los tests**

Run: `cd server && npm test` y `cd client && npm test`
Expected: PASS en ambos.

- [ ] **Step 2: Confirmar con el usuario antes de pushear/deployar** (push dispara deploy del backend en Railway; el frontend se publica según el flujo habitual de ALTORANCHO). Verificar que `PUBLIC_BASE_URL` está seteada en Railway.

- [ ] **Step 3: Cargar tarifas** en Config con los valores de la tabla oficial de Meta (Argentina, Marketing y Utilidad) que confirme el usuario.

- [ ] **Step 4: Prueba punta a punta** (segmento filtrado por búsqueda a un único número propio):
  1. Nueva difusión → Crear plantilla nueva: imagen + `Hola {{primer_nombre}}! ...` + botón "Ver promo" + URL destino. Guardar → estado "Esperando aprobación".
     Si falla con "No se pudo obtener el App ID", cargar `META_APP_ID` en Railway y reintentar.
  2. Esperar aprobación (el detalle cambia solo a Borrador) → Enviar.
  3. En el teléfono: imagen, nombre correcto, botón. Tocar el botón → abre la URL destino y la difusión suma 1 click.
  4. Repetir con link "En el texto".
  5. Nueva difusión usando la plantilla ya aprobada del punto 1 con **otra** imagen → llega la imagen nueva.
  6. Una difusión legacy (plantilla vieja de texto) sigue enviándose igual.
