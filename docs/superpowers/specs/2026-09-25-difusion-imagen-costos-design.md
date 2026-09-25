# Difusiones: plantilla inline con imagen + variables, y calculadora de costo

Fecha: 2026-09-25 · Estado: diseño aprobado en chat, pendiente revisión del spec

## Objetivo

Alto Rancho quiere mandar difusiones con imagen y saber de antemano cuánto van a costar.
Hoy sólo se pueden elegir plantillas de texto ya aprobadas; crear una plantilla es un
paso aparte (pantalla Plantillas) que sólo soporta BODY.

Éxito =
1. Desde **Nueva difusión** se puede crear la plantilla ahí mismo: texto con datos del
   contacto insertados desde una lista, imagen opcional, y link como botón o en el texto.
2. La difusión queda esperando la aprobación de Meta y se habilita Enviar sola al aprobarse.
3. Cada destinatario recibe imagen + texto personalizado + link trackeado (clicks por contacto
   siguen funcionando).
4. Mientras se arma el segmento se ve el costo estimado en USD (y ARS si hay cotización).

Dicho por el usuario: crear plantilla desde Difusión; variables elegidas de una lista de datos
del contacto; las plantillas se aprueban rápido; elegir cómo se muestra el link.
Supuestos: se sigue usando sólo WhatsApp; categoría Marketing es la habitual para promos.

## Fuera de alcance

- Programar difusiones para más tarde.
- Header de video / documento / texto.
- Editar plantillas ya aprobadas.
- Costos reales por difusión desde la API de Meta (la pantalla Costos ya muestra el mensual).

## UX

### Nueva difusión → paso "Mensaje"

Selector: **Usar plantilla aprobada** (flujo actual) | **Crear plantilla nueva**.

Si se usa una plantilla aprobada que tiene header IMAGE, aparece el campo "Imagen" (obligatorio).

"Crear plantilla nueva" muestra:

1. **Nombre técnico**: autogenerado desde el nombre de la difusión
   (`promo_dia_padre_0925` — minúsculas, `[a-z0-9_]`, máx 512), editable.
2. **Categoría**: Marketing (default) | Utilidad.
3. **Imagen** (opcional): jpg/png, se comprime con `ensureWhatsAppImageSize` si excede.
4. **Texto**: textarea + botón **"+ Insertar dato"** que inserta en el cursor:

   | Etiqueta          | Token             | Valor                                  | Fallback   |
   |-------------------|-------------------|----------------------------------------|------------|
   | Nombre completo   | `{{nombre}}`      | `contactName`                          | `Cliente`  |
   | Primer nombre     | `{{primer_nombre}}` | primera palabra de `contactName`     | `Cliente`  |
   | Cantidad de pedidos | `{{pedidos}}`   | `tnOrderCount`                         | `0`        |
   | Total gastado     | `{{gastado}}`     | `tnTotalSpent` redondeado, formato `$ 12.345` | `$ 0` |
   | Último pedido     | `{{ultimo_pedido}}` | `tnLastOrderAt` como `dd/mm/aaaa`    | `-`        |
   | Link de la promo  | `{{link}}`        | link corto trackeado                   | —          |

   `{{link}}` sólo se ofrece si el modo de link es "En el texto".
5. **Link**: `Botón` (default, con texto editable, default "Ver promo", máx 25 chars) |
   `En el texto` | `Sin link`. Si no es "Sin link", se pide la **URL destino**.
   `Botón` se deshabilita (con aviso) si el backend no tiene `PUBLIC_BASE_URL`.
6. **Vista previa WhatsApp**: burbuja con imagen, texto resuelto con el primer contacto
   de la muestra del segmento, y botón.

Guardar → se crea plantilla en Meta + difusión en estado **Esperando aprobación**.
Mientras el detalle está abierto, se consulta el estado cada 10 s. Aprobada → estado
`draft`, se habilita Enviar. Rechazada → se muestra el motivo de Meta; la difusión queda
en `template_rejected` y se puede borrar y recrear (no se edita in-place).

### Calculadora

Debajo del segmento, siempre visible (con plantilla elegida o creada):

`1.240 contactos de WhatsApp × USD 0,0618 (Marketing) ≈ USD 76,63  (≈ $ 91.956)`

Nota fija: "Estimado. Meta cobra sólo los mensajes entregados; las tarifas se editan en Config."
Si la categoría no tiene tarifa cargada → "Cargá la tarifa en Config".

### Config

Sección "Tarifas WhatsApp": USD por mensaje Marketing, USD por mensaje Utilidad,
cotización ARS por USD (opcional). Los valores iniciales se cargan tras confirmarlos en
la tabla oficial de precios de Meta para Argentina (no se hardcodean en el código).

### Plantillas

Badge "Imagen" / "Botón" en las plantillas que los tengan.

## Diseño técnico

### `server/src/services/templateVars.js` (nuevo, puro)

- `TEMPLATE_VARS`: la tabla de arriba (`key`, `label`, `resolve(contact)`, `fallback`, `sample`).
- `toMetaBody(text) → { body, order }`: reemplaza cada token distinto por `{{1}}`, `{{2}}`…
  en orden de primera aparición; un token repetido reusa su número. Tokens desconocidos → error 400.
- `resolveVars(order, contact, link) → string[]`: valores en el orden de `order`, con fallback.
  Nunca devuelve string vacío (Meta rechaza parámetros vacíos).
- `sampleValues(order) → string[]`: ejemplos para `example.body_text` al crear la plantilla.

Campañas viejas: `paramsTemplate` (strings con `{{nombre}}` etc.) se sigue soportando;
se resuelve cada string reemplazando tokens con la misma tabla. Reemplaza a `interpolate`.

### `meta.service.js`

- `getMetaAppId()`: `GET /debug_token?input_token=<token>&access_token=<token>` → `data.app_id`,
  cacheado en memoria; `process.env.META_APP_ID` tiene prioridad.
- `uploadTemplateSampleImage(buffer, mime) → handle`: Resumable Upload API:
  `POST /{appId}/uploads?file_length&file_type` → `{id}`; `POST /{id}` con
  `Authorization: OAuth <token>`, `file_offset: 0`, body binario → `{h}`.
- `createMetaTemplate({ name, language, category, bodyText, params, header, button })`:
  - `header: { format: 'IMAGE', handle }` → `{ type:'HEADER', format:'IMAGE', example:{ header_handle:[handle] } }`
  - `button: { text, urlBase }` → `{ type:'BUTTONS', buttons:[{ type:'URL', text, url:`${urlBase}/r/{{1}}`, example:[`${urlBase}/r/ejemplo1`] }] }`
  - Sin `header`/`button` → payload idéntico al actual.
- `buildTemplateObject(name, lang, params, urlButtonParam, headerImageId = null)`:
  si hay `headerImageId`, antepone `{ type:'header', parameters:[{ type:'image', image:{ id } }] }`.
  Las llamadas existentes no cambian. `sendWhatsAppTemplate` recibe y pasa el nuevo argumento.
- `fetchMetaTemplateStatuses`: pedir también `components,rejected_reason,category`.

### `template.service.js`

- `createTemplate` acepta `header`, `button`, `varOrder` y los guarda:
  `headerFormat: 'IMAGE' | null`, `button: { text } | null`, `varOrder: string[] | null`.
- `syncTemplateStatuses` guarda además `headerFormat` y `hasUrlButton` desde `components`
  (así plantillas creadas a mano en Meta también se detectan) y `rejectedReason`.
- `syncTemplateStatus(name, language)`: sync de una sola plantilla para el polling.

### `campaign.service.js`

Campos nuevos en la campaña:
`linkMode: 'button' | 'text' | 'none'`, `varOrder: string[] | null`,
`headerImage: { mediaId, uploadedAt } | null`, `templateStatus`.
Estados: `pending_template` → `draft` → `sending` → `sent`; o `template_rejected`.

- `createCampaignWithTemplate({ ...campaign, template, imageFile })`:
  1. Valida nombre técnico y texto (`toMetaBody`).
  2. Si hay imagen: comprime → `uploadTemplateSampleImage` (handle) + `uploadMetaMedia` (mediaId).
  3. `createTemplate(...)`. Si Meta falla → error 400/502 con el mensaje de Meta; no se crea la campaña.
  4. Crea la campaña en `pending_template` (o `draft` si Meta ya devolvió APPROVED).
- `setCampaignImage(id, imageFile)`: comprime + `uploadMetaMedia`, guarda `headerImage`.
- `refreshTemplateStatus(id)`: `syncTemplateStatus` → APPROVED ⇒ `draft`; REJECTED ⇒ `template_rejected` + motivo.
- `sendCampaign`:
  - 409 si `status !== 'draft'`.
  - 400 si la plantilla tiene header IMAGE y no hay `headerImage`, o si `uploadedAt` tiene más de 29 días
    ("Volvé a subir la imagen").
  - Por destinatario: short link si `linkMode !== 'none'` y hay `PUBLIC_BASE_URL`;
    `linkMode==='button'` ⇒ `urlButtonParam = shortCode`; `linkMode==='text'` ⇒ `{{link}}` = URL corta.
  - Params: `resolveVars(varOrder, …)` si hay `varOrder`, si no el camino legacy de `paramsTemplate`.
  - El mensaje registrado en la conversación incluye `[Imagen]` si lleva header.

### Rutas (`campaign.routes.js`)

- `POST /api/campaigns/with-template` — multipart (`multer` memoria, 5 MB, sólo `image/*`),
  campo `data` con el JSON de campaña + plantilla, campo `image` opcional.
- `POST /api/campaigns/:id/image` — multipart, reemplaza la imagen de una campaña `draft`/`pending_template`.
- `GET /api/campaigns/:id/template-status` — llama `refreshTemplateStatus`, devuelve la campaña.
- `GET /api/campaigns/meta-info` — `{ canUseButton: !!PUBLIC_BASE_URL }`.
- La miniatura se muestra vía el proxy existente `/api/conversations/media/:mediaId`.

### Config

Doc de config existente suma `pricing: { marketing: number|null, utility: number|null, arsRate: number|null }`.

### Frontend

- `Campaigns.jsx` se divide:
  - `components/Campaigns/TemplateComposer.jsx` — nombre, categoría, imagen, texto + "Insertar dato", modo de link.
  - `components/Campaigns/WhatsAppPreview.jsx` — burbuja (imagen/texto/botón).
  - `components/Campaigns/CostEstimate.jsx` — `count × tarifa(categoría)`, formato USD/ARS.
  - La lista de datos insertables se replica en `client/src/utils/templateVars.js`
    (key, label, sample) para el preview; la resolución real es sólo del backend.
- Detalle de campaña: badge del estado, polling de `template-status` cada 10 s en `pending_template`,
  motivo de rechazo, botón "Cambiar imagen".
- `Config.jsx`: sección Tarifas. `Templates.jsx`: badges.

## Errores

- Meta rechaza la creación (nombre duplicado, formato) → mensaje de Meta en el modal, nada creado.
- Falla la subida de imagen → error antes de crear la plantilla.
- `getMetaAppId` falla → "No se pudo obtener el App ID de Meta; cargá META_APP_ID en Railway".
- Envío por destinatario: igual que hoy (se registra `error` en SENDS y sigue).

## Pruebas

Unit (`node --test`):
- `templateVars.test.js`: orden y reuso de tokens, token desconocido, primer nombre,
  fallbacks, formato de gastado/fecha, nunca vacío.
- `metaTemplate.test.js`: `buildTemplateObject` con header imagen (+ botón), sin regresión en los casos actuales;
  payload de `createMetaTemplate` con header y botón (función pura extraída `buildTemplateCreatePayload`).
- Cálculo de costo (función pura en el frontend o util compartido).

Manual en producción:
1. Crear difusión con plantilla nueva (imagen + `{{primer_nombre}}` + botón), segmento filtrado a un solo número propio.
2. Esperar aprobación → Enviar → verificar imagen, nombre, botón, y que el click sume en stats.
3. Repetir con modo "En el texto" y con plantilla aprobada existente + imagen nueva.
