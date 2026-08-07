# Tacho de archivados sin restricción Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir la pestaña "Archivos" del panel de conversaciones en un tacho real: todo agente ve el historial completo de conversaciones `resolved`/`bot_archived`, sin el límite de 200 ni la restricción por departamento que hoy hereda del listado principal.

**Architecture:** Nuevo endpoint `GET /api/conversations/archived` respaldado por `listArchivedConversations()`, que consulta Firestore directamente por `status in ['resolved', 'bot_archived']` (consulta indexada, no escaneo completo) sin `assignedTo` ni `limit`. El frontend, al entrar a la pestaña "Archivos", pide esa lista y la usa en vez de derivar del array `conversations` (que sigue limitado a 200 y restringido por departamento para el resto de las pestañas, sin cambios).

**Tech Stack:** Node.js (ESM) + Express, Firebase Firestore (`firebase-admin`), React + Vite. Sin framework de testing — verificación manual con curl y en el navegador (mismo criterio que la feature de búsqueda global).

## Global Constraints

- El endpoint `/archived` no debe aplicar ningún filtro de `assignedTo`/departamento — aplica igual para todos los roles (admin, atención al cliente, operador).
- Sin límite de resultados ni de antigüedad.
- No modificar la lógica de reapertura automática en `bot.service.js` (ya existe y cumple lo pedido — no forma parte de este plan).
- No modificar el comportamiento de las demás pestañas ni de `GET /api/conversations` (límite 200, restricción por departamento para `operador` se mantienen intactos).
- Sin frameworks de testing nuevos — verificación manual (curl + navegador).
- Spec de referencia: `docs/superpowers/specs/2026-08-07-tacho-archivados-design.md`.

---

### Task 1: Backend — `listArchivedConversations` + endpoint

**Files:**
- Modify: `server/src/services/conversation.service.js` (agregar función nueva después de `listConversations`, línea 276)
- Modify: `server/src/routes/conversation.routes.js` (import + ruta nueva)

**Interfaces:**
- Consumes: `mapConversationDoc(doc, data)` y `tsToMs(ts)` — funciones privadas ya definidas en `conversation.service.js` (líneas 229 y 278 respectivamente).
- Produces: `export async function listArchivedConversations()` → `Promise<Array<ConversationSummary>>` (mismo shape que `listConversations`/`searchConversations`, consumido sin cambios por `ConvItem` en el frontend). Endpoint HTTP `GET /api/conversations/archived` → `{ conversations: ConversationSummary[] }`, consumido por Task 2 (frontend).

- [ ] **Step 1: Agregar `listArchivedConversations` en `conversation.service.js`**

Insertar inmediatamente después del cierre de `listConversations` (después de la línea 276, `}`):

```js
export async function listArchivedConversations() {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION)
    .where('status', 'in', ['resolved', 'bot_archived'])
    .get();
  return snapshot.docs
    .map(doc => mapConversationDoc(doc, doc.data()))
    .sort((a, b) => tsToMs(b.updatedAt) - tsToMs(a.updatedAt));
}
```

Nota: se ordena en memoria (no con `.orderBy('updatedAt')` de Firestore) para no depender de un índice compuesto `status + updatedAt` que hoy no existe en el proyecto. `tsToMs` está definida más abajo en el archivo (línea 278) pero al ser `function` declarada, el hoisting de JS permite usarla acá sin problema.

- [ ] **Step 2: Verificar manualmente contra Firestore real**

Run: `cd server && node -e "
import('dotenv/config').then(async () => {
  const { initFirebase } = await import('./src/services/firebase.service.js');
  initFirebase();
  const m = await import('./src/services/conversation.service.js');
  const archived = await m.listArchivedConversations();
  console.log('total archivadas:', archived.length);
  console.log('todos son resolved/bot_archived:', archived.every(c => c.status === 'resolved' || c.status === 'bot_archived'));
  console.log('orden desc por updatedAt (primeros 3):', archived.slice(0, 3).map(c => c.updatedAt));
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"`

Expected: no tira error, `total archivadas` es mayor que 0, `todos son resolved/bot_archived` es `true`, y las fechas de los primeros 3 están en orden descendente.

- [ ] **Step 3: Comparar contra el límite viejo de 200**

Run: `cd server && node -e "
import('dotenv/config').then(async () => {
  const { initFirebase } = await import('./src/services/firebase.service.js');
  initFirebase();
  const m = await import('./src/services/conversation.service.js');
  const [archived, capped] = await Promise.all([
    m.listArchivedConversations(),
    m.listConversations({}),
  ]);
  const cappedArchivedIds = new Set(capped.filter(c => c.status === 'resolved' || c.status === 'bot_archived').map(c => c.id));
  const onlyInFull = archived.filter(c => !cappedArchivedIds.has(c.id));
  console.log('archivadas totales:', archived.length, '— visibles hoy en el top-200:', cappedArchivedIds.size, '— nuevas gracias al cambio:', onlyInFull.length);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"`

Expected: `nuevas gracias al cambio` es mayor a 0 si hay conversaciones archivadas viejas que hoy quedan fuera del top-200 (confirma que el fix resuelve el problema real reportado).

- [ ] **Step 4: Importar y exponer la ruta**

En `server/src/routes/conversation.routes.js`, modificar el import (líneas 4-18) agregando `listArchivedConversations`:

```js
import {
  listConversations,
  listArchivedConversations,
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

- [ ] **Step 5: Agregar la ruta**

Insertar después del bloque `router.get('/search', ...)` (después de la línea 137, antes de `router.get('/:contactId/messages', ...)` en la línea 139):

```js
// Tacho de archivados: todo el historial resolved/bot_archived, sin límite ni
// restricción de departamento. Debe ir antes de las rutas /:contactId/* para
// no colisionar con ellas.
router.get('/archived', async (req, res) => {
  try {
    const conversations = await listArchivedConversations();
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Levantar el servidor y probar con curl**

Run: `cd server && npm run dev` (en background)

Obtener un token de un agente con rol `operador` de un departamento específico (no admin) — pedirle al usuario cuál usar, o crear uno de prueba vía `POST /api/auth/users` si hace falta. Loguear:

```bash
curl -s -X POST http://localhost:<PUERTO>/api/auth/login -H "Content-Type: application/json" -d '{"email":"<email operador>","password":"<password>"}'
```

Con ese token:
```bash
curl -s "http://localhost:<PUERTO>/api/conversations/archived" -H "Authorization: Bearer <TOKEN_OPERADOR>" | python3 -m json.tool | head -40
```

Expected: la respuesta incluye conversaciones con `assignedTo` de departamentos **distintos** al del operador logueado — confirma que no hay restricción de `assignedTo` en este endpoint (a diferencia de `GET /api/conversations`, que si se prueba con el mismo token solo trae las del departamento propio).

- [ ] **Step 7: Commit**

```bash
git add server/src/services/conversation.service.js server/src/routes/conversation.routes.js
git commit -m "feat(conversations): agregar GET /api/conversations/archived sin límite ni restricción de departamento"
```

---

### Task 2: Frontend — pestaña "Archivos" usa el nuevo endpoint

**Files:**
- Modify: `client/src/pages/Conversations.jsx`

**Interfaces:**
- Consumes: `GET ${BASE_URL}/api/conversations/archived` de Task 1 → `{ conversations: ConversationSummary[] }`.
- Produces: comportamiento de UI, no expone nada a otros archivos.

- [ ] **Step 1: Agregar estado para la lista de archivados**

Junto a la declaración existente `const [searching, setSearching] = useState(false);` (línea 298), agregar debajo:

```js
  const [archivedConversations, setArchivedConversations] = useState(null); // null = no cargado todavía
  const [loadingArchived, setLoadingArchived] = useState(false);
```

- [ ] **Step 2: Agregar `loadArchivedConversations` junto a `loadConversations`**

Insertar inmediatamente después del cierre de `loadConversations` (después de la línea 495, `}`):

```js
  async function loadArchivedConversations() {
    setLoadingArchived(true);
    try {
      const res = await authFetch(BASE_URL + '/api/conversations/archived');
      const data = await res.json();
      setArchivedConversations(data.conversations ?? []);
    } catch {
      setArchivedConversations([]);
    } finally {
      setLoadingArchived(false);
    }
  }
```

- [ ] **Step 3: Cargar la lista al entrar a la pestaña "Archivos"**

Agregar un nuevo `useEffect` después del `useEffect` de búsqueda debounced (después del cierre `}, [search]);` que ya existe):

```js
  useEffect(() => {
    if (filter === 'archived') loadArchivedConversations();
  }, [filter]);
```

- [ ] **Step 4: Usar `archivedConversations` en el cálculo de `filtered`**

Reemplazar la línea `const filtered = searchResults !== null ? searchResults : conversations.filter(c => {` (línea 736) y la rama `else if (filter === 'archived') { if (!isConvArchived) return false; }` (líneas 766-767) del bloque completo:

Old (bloque completo actual, líneas 736-772):
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

New:
```js
  const filtered = searchResults !== null
    ? searchResults
    : filter === 'archived'
      ? (archivedConversations ?? []).filter(c => !labelFilter || (c.labels ?? []).includes(labelFilter))
      : conversations.filter(c => {
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
        }

        if (labelFilter && !(c.labels ?? []).includes(labelFilter)) return false;
        return true;
      });
```

- [ ] **Step 5: Mostrar estado de carga para la pestaña "Archivos"**

Reemplazar el bloque de renderizado de la lista (buscar `{loading ? (` cerca de la línea 837):

Old:
```jsx
          {loading ? (
            <p className={styles.empty}>Cargando...</p>
          ) : searching ? (
            <p className={styles.empty}>Buscando...</p>
          ) : filtered.length === 0 ? (
            <p className={styles.empty}>Sin resultados.</p>
          ) : (
```

New:
```jsx
          {loading ? (
            <p className={styles.empty}>Cargando...</p>
          ) : searching ? (
            <p className={styles.empty}>Buscando...</p>
          ) : (filter === 'archived' && loadingArchived) ? (
            <p className={styles.empty}>Cargando archivados...</p>
          ) : filtered.length === 0 ? (
            <p className={styles.empty}>Sin resultados.</p>
          ) : (
```

- [ ] **Step 6: Probar manualmente en el navegador**

Run: `cd server && npm run dev` y `cd client && npm run dev`, loguearse con un agente `operador` de un departamento específico (no admin).

Casos a probar a mano:
1. Ir a la pestaña "Archivos" → debe aparecer "Cargando archivados..." brevemente y después la lista.
2. Confirmar que aparecen conversaciones archivadas de **otros** departamentos, no solo el propio (comparar con lo que curl mostró en Task 1 Step 6).
3. Aplicar un filtro de etiqueta estando en "Archivos" → la lista se acota correctamente.
4. Cambiar a otra pestaña (ej. "Bot") y volver a "Archivos" → recarga y sigue mostrando lo mismo (sin quedar pegada en el estado viejo).
5. Confirmar que las demás pestañas (Bot, Mis casos, Crítico, Urgentes, Esperando, Equipos, Todos) siguen comportándose exactamente igual que antes de este cambio.

Expected: los 5 casos se cumplen sin errores en la consola del navegador.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Conversations.jsx
git commit -m "feat(conversations): pestaña Archivos muestra todo el historial sin restricción de departamento"
```
