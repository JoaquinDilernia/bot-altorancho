# Búsqueda global de conversaciones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el filtro de búsqueda 100% client-side del panel de conversaciones (limitado a los 200 chats más recientes de la pestaña activa) por un endpoint de backend que busca en toda la base — por nombre/teléfono, texto de mensajes y número de pedido asociado — sin restricción de departamento ni de estado.

**Architecture:** Nuevo endpoint `GET /api/conversations/search?q=` que escanea todos los documentos de Firestore en memoria (sin `assignedTo` ni `limit(200)`), matchea por texto contra nombre/teléfono/mensajes, y en paralelo resuelve números de pedido en vivo contra TiendaNube/Odoo (reutilizando `findOrder`/`findOdooOrder`) para encontrar al cliente dueño de ese pedido aunque el número nunca se haya escrito en el chat. El frontend reemplaza el filtro local por una llamada debounced a este endpoint cuando hay texto en el buscador.

**Tech Stack:** Node.js (ESM) + Express, Firebase Firestore (`firebase-admin`), React + Vite (frontend), sin framework de testing — verificación manual con curl y en el navegador (el proyecto no tiene tests automatizados hoy).

## Global Constraints

- El endpoint de búsqueda no debe aplicar el filtro `assignedTo` que hoy restringe a agentes con rol `operador` — ver spec, sección "Alcance y permisos".
- El listado normal por pestañas (`GET /api/conversations`, sin `q`) no cambia: sigue con `limit(200)` y el filtro `assignedTo` para `operador` intactos.
- La búsqueda incluye conversaciones archivadas/cerradas (sin filtro de `status`).
- Mínimo 2 caracteres antes de disparar una búsqueda (backend y frontend).
- Sin frameworks de testing nuevos — verificación manual (curl + navegador) en cada tarea.
- Spec de referencia: `docs/superpowers/specs/2026-08-07-busqueda-global-conversaciones-design.md`.

---

### Task 1: Odoo — helper para obtener teléfono/email de un partner por ID

**Files:**
- Modify: `server/src/services/odoo.service.js` (agregar función nueva cerca de `findOdooOrder`, después de la línea 151)

**Interfaces:**
- Consumes: `callOdoo(model, method, args, kwargs)` — función privada ya definida en este archivo (línea 31), firma `callOdoo('res.partner', 'read', [[partnerId]], { fields: [...] })`.
- Produces: `export async function getPartnerContact(partnerId)` → `Promise<{ phone: string|false, email: string|false } | null>`. Task 3 la usa para resolver el teléfono de un cliente Odoo a partir de un pedido.

- [ ] **Step 1: Agregar la función `getPartnerContact`**

Insertar inmediatamente después del cierre de `findOdooOrder` (después de la línea 151, `}`):

```js
/**
 * Obtiene teléfono/email de un partner de Odoo por su ID.
 * Usado para resolver el contacto de un cliente a partir de un pedido
 * encontrado por referencia (S.../TN...), sin depender de que el pedido
 * tenga el teléfono embebido en sus campos.
 * @param {number} partnerId
 * @returns {Promise<{phone: string|false, email: string|false}|null>}
 */
export async function getPartnerContact(partnerId) {
  try {
    const results = await callOdoo('res.partner', 'read', [[partnerId]], { fields: ['phone', 'email'] });
    return results?.[0] ?? null;
  } catch (err) {
    console.error('[odoo] getPartnerContact error:', err.message);
    return null;
  }
}
```

- [ ] **Step 2: Verificar manualmente con un script ad-hoc**

Crear un archivo temporal `server/scratch-test-partner.mjs` (fuera de `src/`, se borra en el Step 4):

```js
import 'dotenv/config';
import { findOdooOrder, getPartnerContact } from './src/services/odoo.service.js';

const ref = process.argv[2] ?? 'S08121'; // reemplazar por un número de pedido S... real de la base
const result = await findOdooOrder(ref);
if (!result) {
  console.log(`No se encontró el pedido ${ref}`);
  process.exit(0);
}
const partnerId = Array.isArray(result.order.partner_id) ? result.order.partner_id[0] : null;
console.log('partner_id:', result.order.partner_id);
const contact = partnerId ? await getPartnerContact(partnerId) : null;
console.log('contact:', contact);
```

Run: `cd server && node scratch-test-partner.mjs S08121` (reemplazar `S08121` por un pedido de local real que exista en la base de Alto Rancho — pedirle uno al usuario o buscar uno reciente en Odoo/el panel).

Expected: imprime `partner_id: [<id>, '<nombre>']` seguido de `contact: { phone: '<algo>', email: '<algo>' }` con valores no vacíos (o `false` si el partner no tiene ese dato cargado, pero no debe tirar error ni devolver `null`).

- [ ] **Step 3: Confirmar que no rompe nada existente**

Run: `cd server && node -e "import('./src/services/odoo.service.js').then(m => console.log(Object.keys(m)))"`
Expected: la lista de exports incluye `getPartnerContact` junto a todos los exports previos (`findOdooOrder`, `findPosOrder`, etc. — no debe faltar ninguno).

- [ ] **Step 4: Borrar el script temporal y commitear**

```bash
rm server/scratch-test-partner.mjs
git add server/src/services/odoo.service.js
git commit -m "feat(odoo): agregar getPartnerContact para resolver teléfono/email por partner ID"
```

---

### Task 2: Conversation service — refactor de mapeo + `searchConversations`

**Files:**
- Modify: `server/src/services/conversation.service.js`

**Interfaces:**
- Consumes:
  - `findOrder(query)` de `server/src/services/tiendanube.service.js` → `Promise<object|null>`, el objeto tiene `.customer.phone` (ver `tiendanube.service.js:93`, `ORDER_FIELDS` incluye `customer`).
  - `findOdooOrder(query)` de `server/src/services/odoo.service.js` → `Promise<{order, lines}|null>`, `order.partner_id` es `[id, nombre]`.
  - `getPartnerContact(partnerId)` de Task 1 → `Promise<{phone, email}|null>`.
- Produces: `export async function searchConversations(query)` → `Promise<Array<ConversationSummary>>`, donde `ConversationSummary` es exactamente el mismo shape que ya devuelve `listConversations` (mismo objeto que consume `ConvItem` en el frontend: `id, contactId, contactName, channel, status, humanMode, assignedTo, urgent, critical, unread, labels, messageCount, lastMessage, lastMessageAt, lastClientMessageAt, consecutiveClientMessages, waitingSince, escalatedAt, firstAgentResponseAt, updatedAt, createdAt`). Task 3 llama a esta función desde la ruta.

- [ ] **Step 1: Agregar los imports nuevos**

Al inicio del archivo, después de `import admin from 'firebase-admin';` (línea 2):

```js
import { findOrder } from './tiendanube.service.js';
import { findOdooOrder, getPartnerContact } from './odoo.service.js';
```

- [ ] **Step 2: Extraer `mapConversationDoc` y usarla en `listConversations`**

Reemplazar el cuerpo de `listConversations` (líneas 227-273) completo por:

```js
function mapConversationDoc(doc, data) {
  const lastMsg = data.messages?.slice(-1)[0];

  // Legacy support: status === 'urgent' treated as status: 'bot', urgent: true
  const rawStatus = data.status ?? 'bot';
  const effectiveStatus = rawStatus === 'urgent' ? 'bot' : rawStatus;
  const isUrgent = data.urgent === true || rawStatus === 'urgent';

  return {
    id: doc.id,
    contactId: data.contactId,
    contactName: data.contactName ?? null,
    channel: data.channel,
    status: effectiveStatus,
    humanMode: data.humanMode ?? false,
    assignedTo: data.assignedTo ?? null,
    urgent: isUrgent,
    critical: data.critical === true,
    unread: data.unread ?? 0,
    labels: data.labels ?? [],
    messageCount: data.messages?.length ?? 0,
    lastMessage: lastMsg?.content ?? '',
    lastMessageAt: lastMsg?.timestamp ?? data.updatedAt,
    lastClientMessageAt: data.lastClientMessageAt ?? null,
    consecutiveClientMessages: data.consecutiveClientMessages ?? 0,
    waitingSince: data.waitingSince ?? null,
    escalatedAt: data.escalatedAt ?? null,
    firstAgentResponseAt: data.firstAgentResponseAt ?? null,
    updatedAt: data.updatedAt,
    createdAt: data.createdAt,
  };
}

export async function listConversations(filters = {}) {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION).orderBy('updatedAt', 'desc').limit(200).get();

  let docs = snapshot.docs.map((doc) => mapConversationDoc(doc, doc.data()));

  if (filters.channel) docs = docs.filter(d => d.channel === filters.channel);
  if (filters.status)  docs = docs.filter(d => d.status === filters.status);
  if (filters.assignedTo) {
    const targets = Array.isArray(filters.assignedTo) ? filters.assignedTo : [filters.assignedTo];
    docs = docs.filter(d => targets.includes(d.assignedTo));
  }

  return docs;
}
```

- [ ] **Step 3: Verificar que `listConversations` sigue funcionando igual**

Run: `cd server && node -e "
import('./src/services/conversation.service.js').then(async m => {
  const docs = await m.listConversations({});
  console.log('total:', docs.length);
  console.log('sample:', docs[0]);
});
"`

Expected: no tira error, `total` es un número (hasta 200), y `sample` tiene las mismas keys que antes del refactor (`id, contactId, contactName, channel, status, ...`). Esto requiere que las credenciales de Firebase estén configuradas en el entorno local (mismo `.env` que usa `npm run dev`).

- [ ] **Step 4: Agregar los helpers privados y `searchConversations` al final del archivo**

Agregar al final de `server/src/services/conversation.service.js`:

```js
function tsToMs(ts) {
  if (!ts) return 0;
  if (ts._seconds) return ts._seconds * 1000;
  const d = new Date(ts);
  return isNaN(d) ? 0 : d.getTime();
}

// Compara dos teléfonos ignorando formato (código de país, ceros a la
// izquierda, el "9" de móvil argentino): si los últimos 8 dígitos
// coinciden, se consideran el mismo número.
function phoneDigitsMatch(a, b) {
  if (!a || !b) return false;
  const da = String(a).replace(/\D/g, '');
  const db_ = String(b).replace(/\D/g, '');
  if (da.length < 6 || db_.length < 6) return false;
  return da.slice(-8) === db_.slice(-8);
}

function matchesText(data, qLower) {
  const name = (data.contactName || '').toLowerCase();
  const contactId = (data.contactId || '').toLowerCase();
  if (name.includes(qLower) || contactId.includes(qLower)) return true;
  const messages = data.messages ?? [];
  return messages.some(m => (m.content || '').toLowerCase().includes(qLower));
}

// Misma lógica de reconocimiento de formato de pedido que usa
// searchOrderByRef en bot.service.js (número puro, S-prefijo, TN-prefijo).
async function resolveOrderContactPhone(orderRef) {
  const isPureNumber = /^\d+$/.test(orderRef);
  const isOdooLocal  = /^S\d+$/i.test(orderRef);
  const isOdooTN     = /^TN\d+$/i.test(orderRef);

  if (isPureNumber) {
    const tnOrder = await findOrder(orderRef);
    return tnOrder?.customer?.phone ?? null;
  }

  if (isOdooLocal || isOdooTN) {
    const odooResult = await findOdooOrder(orderRef);
    const partnerId = Array.isArray(odooResult?.order?.partner_id) ? odooResult.order.partner_id[0] : null;
    if (!partnerId) return null;
    const contact = await getPartnerContact(partnerId);
    return contact?.phone || null;
  }

  return null;
}

export async function searchConversations(query) {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  const qLower = q.toLowerCase();

  const db = getDb();
  const snapshot = await db.collection(COLLECTION).get();
  const entries = snapshot.docs.map(doc => ({ doc, data: doc.data() }));

  const textMatchEntries = entries.filter(({ data }) => matchesText(data, qLower));

  const cleanedRef = q.replace(/^#/, '');
  const looksLikeOrderRef = /^\d+$/.test(cleanedRef) || /^S\d+$/i.test(cleanedRef) || /^TN\d+$/i.test(cleanedRef);

  let orderMatchEntries = [];
  if (looksLikeOrderRef) {
    const phone = await resolveOrderContactPhone(cleanedRef);
    if (phone) {
      orderMatchEntries = entries.filter(({ data }) =>
        data.channel === 'whatsapp' && phoneDigitsMatch(data.contactId, phone)
      );
    }
  }

  const merged = new Map();
  for (const { doc, data } of [...textMatchEntries, ...orderMatchEntries]) {
    merged.set(doc.id, mapConversationDoc(doc, data));
  }

  return [...merged.values()]
    .sort((a, b) => tsToMs(b.updatedAt) - tsToMs(a.updatedAt))
    .slice(0, 100);
}
```

- [ ] **Step 5: Verificar `searchConversations` por texto**

Run: `cd server && node -e "
import('./src/services/conversation.service.js').then(async m => {
  const results = await m.searchConversations('a');
  console.log('resultados para \"a\" (esperado: [], < 2 caracteres):', results.length);
  const results2 = await m.searchConversations('<nombre o parte de un contacto real que exista en la base>');
  console.log('resultados:', results2.length, results2[0]);
});
"`

Reemplazar `<nombre o parte de un contacto real...>` por un fragmento de nombre o teléfono que el usuario confirme que existe en la base de Alto Rancho.

Expected: la primera búsqueda (`'a'`) devuelve `0` (por el mínimo de 2 caracteres). La segunda devuelve al menos 1 resultado, y ese resultado tiene la forma completa de `ConversationSummary` (mismas keys que `listConversations`).

- [ ] **Step 6: Verificar `searchConversations` por número de pedido**

Run: `cd server && node -e "
import('./src/services/conversation.service.js').then(async m => {
  const results = await m.searchConversations('<número de pedido real de TiendaNube, ej: 51689>');
  console.log('resultados:', results.length, results.map(r => r.contactName ?? r.contactId));
});
"`

Pedirle al usuario un número de pedido real asociado a un cliente que además tenga una conversación en el bot, para poder confirmar el match end-to-end.

Expected: si ese cliente tiene una conversación de WhatsApp en la base, aparece en los resultados aunque el número de pedido no esté escrito en ningún mensaje del chat.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/conversation.service.js
git commit -m "feat(conversations): agregar searchConversations (texto + pedido en vivo)"
```

---

### Task 3: Ruta `GET /api/conversations/search`

**Files:**
- Modify: `server/src/routes/conversation.routes.js`

**Interfaces:**
- Consumes: `searchConversations(query)` de Task 2, `Promise<Array<ConversationSummary>>`.
- Produces: endpoint HTTP `GET /api/conversations/search?q=<texto>` → `{ conversations: ConversationSummary[] }`. Task 4 (frontend) lo consume.

- [ ] **Step 1: Importar `searchConversations`**

Modificar el bloque de import en la línea 4-17, agregando `searchConversations` a la lista ya importada desde `'../services/conversation.service.js'`:

```js
import {
  listConversations,
  searchConversations,
  getConversationHistory,
  updateConversationStatus,
  updateHumanMode,
  updateAssignment,
  dispatchConversation,
  setUrgentFlag,
  markAsRead,
  appendMessage,
  getOrCreateConversation,
  addLabelToConversation,
  updateMessageStatus,
} from '../services/conversation.service.js';
```

- [ ] **Step 2: Agregar la ruta**

Insertar después del bloque `router.post('/start', ...)` (después de la línea 121, antes de `router.get('/:contactId/messages', ...)` en la línea 123):

```js
// Búsqueda global: sin límite de 200, sin filtro de departamento, incluye archivadas.
// Debe ir antes de las rutas /:contactId/* para no colisionar con ellas.
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || String(q).trim().length < 2) {
      return res.json({ conversations: [] });
    }
    const conversations = await searchConversations(q);
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Levantar el servidor y probar el endpoint con curl**

Run: `cd server && npm run dev` (dejar corriendo en background)

Obtener un token válido: iniciar sesión en el frontend (`npm run dev` en `client/`), abrir devtools → Application → Local Storage → copiar el valor de `altorancho_token`.

Run:
```bash
curl -s "http://localhost:<PUERTO>/api/conversations/search?q=a" -H "Authorization: Bearer <TOKEN>" | head -c 200
```
Expected: `{"conversations":[]}` (query de 1 carácter, por debajo del mínimo).

```bash
curl -s "http://localhost:<PUERTO>/api/conversations/search?q=<fragmento real>" -H "Authorization: Bearer <TOKEN>" | python3 -m json.tool
```
Expected: JSON con `conversations: [...]`, al menos un resultado si el fragmento existe en la base, cada uno con el shape completo de `ConversationSummary`.

```bash
curl -s "http://localhost:<PUERTO>/api/conversations/search" -H "Authorization: Bearer <TOKEN>"
```
Expected: `{"conversations":[]}` (sin `q`, no debe tirar 500).

- [ ] **Step 4: Confirmar que no rompe la ruta `/:contactId/messages`**

Run: `curl -s "http://localhost:<PUERTO>/api/conversations/<algún contactId real>/messages" -H "Authorization: Bearer <TOKEN>"`
Expected: sigue devolviendo `{"messages": [...]}` como antes — confirma que `/search` no colisiona con las rutas parametrizadas existentes.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/conversation.routes.js
git commit -m "feat(conversations): exponer GET /api/conversations/search"
```

---

### Task 4: Frontend — reemplazar el filtro local por el endpoint de búsqueda

**Files:**
- Modify: `client/src/pages/Conversations.jsx`

**Interfaces:**
- Consumes: `GET ${BASE_URL}/api/conversations/search?q=<texto>` de Task 3 → `{ conversations: ConversationSummary[] }` (mismo shape que `conversations` ya usa hoy, así que `ConvItem` no necesita cambios).
- Produces: comportamiento de UI; no expone nada a otros archivos.

- [ ] **Step 1: Agregar estado para resultados de búsqueda**

Junto a la declaración existente `const [search, setSearch] = useState('');` (línea 296), agregar debajo:

```js
  const [searchResults, setSearchResults] = useState(null); // null = no está buscando; array = resultados del backend
  const [searching, setSearching] = useState(false);
```

- [ ] **Step 2: Agregar el efecto debounced que llama al backend**

Agregar un nuevo `useEffect` después del `useEffect` de polling de conversaciones (después de la línea 358, `}, []);`):

```js
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await authFetch(BASE_URL + `/api/conversations/search?q=${encodeURIComponent(term)}`);
        const data = await res.json();
        setSearchResults(data.conversations ?? []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [search]);
```

- [ ] **Step 3: Usar `searchResults` en vez del filtro local cuando hay búsqueda activa**

Reemplazar el bloque `const filtered = conversations.filter(c => { ... });` (líneas 712-753) por:

```js
  const filtered = searchResults !== null ? searchResults : conversations.filter(c => {
    const status = c.status || 'bot';
    const isConvArchived = status === 'bot_archived' || status === 'resolved';
    const convUrgent = c.urgent === true;
    const convHuman = c.humanMode === true;

    if (filter === 'bot') {
      if (isConvArchived) return false;
      if (convHuman) return false;
      if (status !== 'bot') return false;
    } else if (filter === 'mine') {
      if (isConvArchived) return false;
      const myDept = agent?.department;
      if (!convHuman || (c.assignedTo !== myId && (!myDept || c.assignedTo !== myDept))) return false;
    } else if (filter === 'critical') {
      if (isConvArchived) return false;
      if (!c.critical) return false;
    } else if (filter === 'urgent') {
      if (isConvArchived) return false;
      if (!convUrgent) return false;
    } else if (filter === 'waiting') {
      if (isConvArchived) return false;
      if (!convHuman) return false;
      if (getSlaWaitMs(c) < 60 * 60 * 1000) return false;
    } else if (filter === 'teams') {
      if (isConvArchived) return false;
      if (!convHuman) return false;
      if (teamsDeptFilter && c.assignedTo !== teamsDeptFilter) return false;
    } else if (filter === 'all') {
      if (isConvArchived) return false;
    } else if (filter === 'archived') {
      if (!isConvArchived) return false;
    }

    if (labelFilter && !(c.labels ?? []).includes(labelFilter)) return false;
    return true;
  });
```

Nota: se removió por completo el bloque `if (search) { ... }` que hacía el filtro local por nombre — ahora ese caso lo cubre `searchResults` cuando hay 2+ caracteres, y por debajo de 2 caracteres no se filtra por texto (se ve la lista normal de la pestaña).

- [ ] **Step 4: Mostrar estado de carga mientras busca**

Reemplazar el bloque de renderizado de la lista (líneas 818-833):

```jsx
          {loading ? (
            <p className={styles.empty}>Cargando...</p>
          ) : searching ? (
            <p className={styles.empty}>Buscando...</p>
          ) : filtered.length === 0 ? (
            <p className={styles.empty}>Sin resultados.</p>
          ) : (
            filtered.map(c => (
              <ConvItem
                key={c.id}
                conv={c}
                active={selected?.id === c.id}
                onClick={() => setSelected(c)}
                labelMap={labelMap}
                nameMap={nameMap}
              />
            ))
          )}
```

- [ ] **Step 5: Probar manualmente en el navegador**

Run: `cd client && npm run dev`, abrir el panel, loguearse.

Casos a probar a mano:
1. Escribir un nombre/teléfono de un contacto que **no** está en la pestaña actual (ej. estando en "Bot", buscar el nombre de alguien escalado a otro departamento) → debe aparecer en los resultados.
2. Escribir una palabra que sepas que se mencionó dentro de un mensaje de algún chat (ej. "factura") → ese chat debe aparecer aunque el nombre/teléfono no la contenga.
3. Escribir un número de pedido real de un cliente que tenga chat en el bot, que **nunca** haya escrito ese número en la conversación → el chat de ese cliente debe aparecer.
4. Borrar el buscador → la vista vuelve a comportarse como antes (pestañas, límite de 200, sin resultados de búsqueda).
5. Verificar que mientras se tipea aparece brevemente "Buscando..." antes de los resultados.

Expected: los 5 casos se cumplen sin errores en la consola del navegador.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Conversations.jsx
git commit -m "feat(conversations): usar búsqueda de backend en vez del filtro local"
```
