# Corrección: reapertura automática de conversaciones archivadas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corregir 2 causas confirmadas por las que conversaciones archivadas/resueltas no vuelven a `status: 'bot'` cuando el cliente escribe de nuevo, y agregar reapertura cuando un agente le escribe directo a una conversación archivada.

**Architecture:** Tres cambios independientes en tres archivos distintos: `inactivity.service.js` (el cron deja de dejar `humanMode` residual al auto-resolver), `bot.service.js` (la reapertura automática ya no depende de `humanMode`, se auto-repara), `conversation.routes.js` (responder/mandar media a una conversación archivada la reabre).

**Tech Stack:** Node.js (ESM) + Express, Firestore. Sin framework de testing en este repo — verificación con `node -e` scripts contra Firestore real y curl con un contacto de prueba (nunca contra clientes reales).

## Global Constraints

- No migrar las 43 conversaciones ya atascadas como parte de este cambio (ver spec, sección "Fuera de alcance") — se autocorrigen en cuanto el cliente vuelva a escribir.
- No enviar mensajes reales de WhatsApp a clientes durante la verificación — usar un contacto de prueba (mismo criterio que planes anteriores de esta sesión).
- No intentar diagnosticar/arreglar los 9 casos sin respuesta posterior (sin evidencia suficiente).
- Spec de referencia: `docs/superpowers/specs/2026-08-11-fix-reapertura-archivados-design.md`.

---

### Task 1: El cron de inactividad limpia `humanMode` al auto-resolver

**Files:**
- Modify: `server/src/services/inactivity.service.js`

**Interfaces:**
- Consumes: `dispatchConversation(contactId, patch)` — ya existe en `conversation.service.js`, se usa en todo el resto de la app para transiciones de estado completas.

- [ ] **Step 1: Importar `dispatchConversation`**

Old:
```js
import { updateConversationStatus } from './conversation.service.js';
```

New:
```js
import { updateConversationStatus, dispatchConversation } from './conversation.service.js';
```

(`updateConversationStatus` se sigue usando en el bloque de conversaciones bot-only más arriba en el archivo — no se toca ese.)

- [ ] **Step 2: Cambiar el cierre de escaladas para que limpie `humanMode`**

Old:
```js
  for (const doc of staleEscalatedDocs) {
    const data = doc.data();
    const contactId = doc.id;
    await sendFarewell(contactId, data.channel);
    try {
      // Resolved (no bot_archived) — la atendió/la tenía asignada un humano
      await updateConversationStatus(contactId, 'resolved');
      console.log(`[inactivity] Resuelta por inactividad ${contactId} (${data.channel}, era de ${data.assignedTo ?? 'sin asignar'}) → resolved`);
    } catch (err) {
      console.error(`[inactivity] Error resolviendo escalada ${contactId}:`, err.message);
    }
  }
```

New:
```js
  for (const doc of staleEscalatedDocs) {
    const data = doc.data();
    const contactId = doc.id;
    await sendFarewell(contactId, data.channel);
    try {
      // Resolved (no bot_archived) — la atendió/la tenía asignada un humano.
      // dispatchConversation (no updateConversationStatus) apaga humanMode
      // junto con el status — si no, queda "resolved" con humanMode todavía
      // en true y la reapertura automática nunca se dispara cuando el
      // cliente vuelve a escribir.
      await dispatchConversation(contactId, { status: 'resolved', humanMode: false });
      console.log(`[inactivity] Resuelta por inactividad ${contactId} (${data.channel}, era de ${data.assignedTo ?? 'sin asignar'}) → resolved`);
    } catch (err) {
      console.error(`[inactivity] Error resolviendo escalada ${contactId}:`, err.message);
    }
  }
```

- [ ] **Step 3: Verificar contra un "zombie" real ya atascado**

Run desde `server/`: `node -e "
import('dotenv/config').then(async () => {
  const { initFirebase } = await import('./src/services/firebase.service.js');
  initFirebase();
  const { getDb } = await import('./src/services/firebase.service.js');
  const { dispatchConversation } = await import('./src/services/conversation.service.js');
  const snap = await getDb().collection('bot-altorancho_conversations')
    .where('status', '==', 'resolved').where('humanMode', '==', true).limit(1).get();
  if (snap.empty) { console.log('No hay zombies resolved+humanMode:true para probar (ok si Task 1 se corre después de que ya no existan)'); process.exit(0); }
  const contactId = snap.docs[0].id;
  console.log('Probando con:', contactId);
  await dispatchConversation(contactId, { status: 'resolved', humanMode: false });
  const after = await getDb().collection('bot-altorancho_conversations').doc(contactId).get();
  console.log('humanMode después:', after.data().humanMode, '(esperado: false)');
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"`

Expected: `humanMode después: false`. Nota: este paso de paso usa un caso real ya atascado para confirmar que `dispatchConversation` limpia `humanMode` correctamente — de yapa, corrige esa conversación puntual (que de todos modos se iba a autocorregir con este fix en la próxima corrida del cron, o en cuanto el cliente escriba gracias al Task 2).

- [ ] **Step 4: Commit**

```bash
git add server/src/services/inactivity.service.js
git commit -m "fix(inactivity): limpiar humanMode al auto-resolver escaladas inactivas"
```

---

### Task 2: La reapertura automática deja de depender de `humanMode`

**Files:**
- Modify: `server/src/services/bot.service.js` (línea ~368)

**Interfaces:**
- No cambia ninguna interfaz — mismo bloque, condición más simple.

- [ ] **Step 1: Quitar la condición `!conversation.humanMode`**

Old:
```js
  const isArchived = ['resolved', 'bot_archived'].includes(conversation.status)
    || conversation.status === 'urgent'; // legacy urgent status
  if (isArchived && !conversation.humanMode) {
```

New:
```js
  const isArchived = ['resolved', 'bot_archived'].includes(conversation.status)
    || conversation.status === 'urgent'; // legacy urgent status
  // Si el status es resolved/bot_archived, no debería haber nadie manejando
  // la conversación en modo humano — esa combinación es en sí misma un
  // estado inconsistente (ver Task 1). Se fuerza humanMode a false acá sin
  // depender de su valor previo, para que el sistema se autorepare ante
  // cualquier otra forma en que ese estado inconsistente pueda producirse.
  if (isArchived) {
```

(El resto del bloque —que ya fuerza `status: 'bot'`, `humanMode: false`, `assignedTo: null`— no cambia.)

- [ ] **Step 2: Verificar que el archivo importa sin errores**

Run desde `server/`: `node -e "
import('./src/services/bot.service.js').then(() => {
  console.log('bot.service.js importa sin errores');
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"`

Expected: imprime `bot.service.js importa sin errores`.

- [ ] **Step 3: Verificar contra las 43 conversaciones atascadas encontradas en la auditoría**

Run desde `server/`: `node -e "
import('dotenv/config').then(async () => {
  const { initFirebase } = await import('./src/services/firebase.service.js');
  initFirebase();
  const { getDb } = await import('./src/services/firebase.service.js');
  const snap = await getDb().collection('bot-altorancho_conversations')
    .where('status', 'in', ['resolved', 'bot_archived']).get();
  let stuck = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const resolvedAt = d.resolvedAt?.toDate?.() ?? null;
    const lastClientMsg = d.lastClientMessageAt?.toDate?.() ?? null;
    if (resolvedAt && lastClientMsg && lastClientMsg > resolvedAt) stuck++;
  }
  console.log('conversaciones todavía atascadas ahora mismo:', stuck);
  console.log('(con el Task 1 + Task 2 aplicados, todas estas se destrabarían en cuanto el cliente vuelva a escribir — sin importar si humanMode quedó en true o false)');
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"`

Expected: confirma el número de conversaciones que se van a autocorregir con este fix (debería ser ≤43, puede ser menor si el Task 1 ya destrabó alguna).

- [ ] **Step 4: Commit**

```bash
git add server/src/services/bot.service.js
git commit -m "fix(bot): la reapertura automática ya no depende de humanMode"
```

---

### Task 3: Un agente que responde a una conversación archivada la reabre

**Files:**
- Modify: `server/src/routes/conversation.routes.js` (`POST /:contactId/reply` línea ~257, `POST /:contactId/media` línea ~358)

**Interfaces:**
- Consumes: `dispatchConversation` — ya importado en este archivo (se usa en `/dispatch`).

- [ ] **Step 1: Reabrir en `POST /:contactId/reply`**

Old:
```js
    const db = getDb();
    const doc = await db.collection('bot-altorancho_conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });

    const { channel } = doc.data();

    // Generate a local message ID for tracking delivery status
    const msgId = crypto.randomUUID();
```

New:
```js
    const db = getDb();
    const doc = await db.collection('bot-altorancho_conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });

    const { channel, status } = doc.data();

    // Si la conversación estaba archivada/resuelta, un agente escribiéndole
    // directo la reabre — si no, queda invisible en Archivados mientras la
    // charla sigue (ver docs/superpowers/specs/2026-08-11-fix-reapertura-archivados-design.md)
    if (status === 'resolved' || status === 'bot_archived') {
      await dispatchConversation(contactId, { status: 'escalated', humanMode: true, assignedTo: req.agent.email });
    }

    // Generate a local message ID for tracking delivery status
    const msgId = crypto.randomUUID();
```

- [ ] **Step 2: Reabrir en `POST /:contactId/media`**

Old:
```js
    const db = getDb();
    const doc = await db.collection('bot-altorancho_conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { channel } = doc.data();

    const { buffer, mimetype, originalname } = req.file;
```

New:
```js
    const db = getDb();
    const doc = await db.collection('bot-altorancho_conversations').doc(contactId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { channel, status } = doc.data();

    // Mismo criterio que en /reply: mandar un archivo a una conversación
    // archivada la reabre, en vez de dejarla invisible en Archivados.
    if (status === 'resolved' || status === 'bot_archived') {
      await dispatchConversation(contactId, { status: 'escalated', humanMode: true, assignedTo: req.agent.email });
    }

    const { buffer, mimetype, originalname } = req.file;
```

- [ ] **Step 3: Levantar el server y probar con un contacto de prueba (NUNCA un cliente real)**

Run: `cd server && npm run dev` (en background).

Crear una conversación de prueba ya archivada:

```bash
node -e "
import('dotenv/config').then(async () => {
  const { initFirebase } = await import('./src/services/firebase.service.js');
  initFirebase();
  const conv = await import('./src/services/conversation.service.js');
  const TEST_PHONE = '5491100000000';
  await conv.getOrCreateConversation(TEST_PHONE, 'whatsapp', 'Test Reapertura');
  await conv.dispatchConversation(TEST_PHONE, { status: 'bot_archived', humanMode: false, assignedTo: null });
  console.log('Conversación de prueba creada y archivada');
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"
```

Con un token de agente válido, mandarle una respuesta (el envío real a Meta va a fallar porque el número es falso — eso es esperado y no rompe la prueba, lo que importa es el cambio de status):

```bash
curl -s -X POST "http://localhost:<PUERTO>/api/conversations/5491100000000/reply" -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"message":"prueba de reapertura"}'
```

Después, confirmar el status resultante:

```bash
node -e "
import('dotenv/config').then(async () => {
  const { initFirebase } = await import('./src/services/firebase.service.js');
  initFirebase();
  const { getDb } = await import('./src/services/firebase.service.js');
  const doc = await getDb().collection('bot-altorancho_conversations').doc('5491100000000').get();
  const d = doc.data();
  console.log('status:', d.status, '— humanMode:', d.humanMode, '— assignedTo:', d.assignedTo);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"
```

Expected: `status: escalated`, `humanMode: true`, `assignedTo` es el email del agente del token usado (no `bot_archived`).

- [ ] **Step 4: Limpiar la conversación de prueba**

```bash
node -e "
import('dotenv/config').then(async () => {
  const { initFirebase } = await import('./src/services/firebase.service.js');
  initFirebase();
  const { getDb } = await import('./src/services/firebase.service.js');
  await getDb().collection('bot-altorancho_conversations').doc('5491100000000').delete();
  console.log('conversación de prueba eliminada');
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/conversation.routes.js
git commit -m "fix(conversations): reabrir una conversación archivada cuando un agente le responde"
```
