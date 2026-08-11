# Filtro "Notificaciones" en Conversaciones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un chip de filtro "Notificaciones" en la página de Conversaciones que muestre solo las conversaciones que recibieron una plantilla masiva (envíos de "retiro en local" desde la página de Notificaciones) y cuyo cliente todavía no respondió.

**Architecture:** Se agrega un campo `notifiedAt` (Firestore Timestamp) al documento de conversación, seteado por un nuevo setter `markNotified(contactId)` en `conversation.service.js`, llamado desde `sendBulkOrders` (`notifications.service.js`) solo cuando el envío de la plantilla fue exitoso. El campo se expone al frontend vía `mapConversationDoc` (mismo mecanismo que los demás campos derivados, sin endpoint nuevo). El frontend agrega un chip de filtro más que reutiliza el array `conversations` ya cargado (mismo patrón que los filtros "Bot"/"Crítico"/etc.), comparando `notifiedAt` contra `lastClientMessageAt` con el helper `tsToDate` que ya existe en `Conversations.jsx`.

**Tech Stack:** Node.js (ESM) + Express, Firebase Firestore (`firebase-admin`), React + Vite. Sin framework de testing en este repo — verificación manual con `node -e` scripts, curl y en el navegador (mismo criterio que los planes anteriores del proyecto, ver `docs/superpowers/plans/2026-08-07-tacho-archivados.md`).

## Global Constraints

- No modificar el comportamiento de los demás filtros existentes (Bot, Mis casos, Crítico, Urgentes, Esperando, Archivos, Equipos, Todos).
- `notifiedAt` se setea únicamente cuando el envío de la plantilla fue exitoso (`status: 'sent'` en `sendBulkOrders`) — un envío fallido o sin teléfono (`error`/`skipped`) no debe marcar la conversación como notificada.
- Los recordatorios automáticos de seguimiento (día 3 / día 7, `sendFollowupTemplate`) quedan fuera de alcance: no llaman `appendMessage` hoy y no deben tocarse en este plan.
- No agregar campos extra (número de pedido, sucursal) al documento de conversación — ese detalle ya está en el preview del último mensaje.
- Spec de referencia: `docs/superpowers/specs/2026-08-11-filtro-notificaciones-design.md`.

---

### Task 1: Backend — marcar `notifiedAt` al enviar una plantilla masiva

**Files:**
- Modify: `server/src/services/conversation.service.js` (nuevo setter `markNotified`, después de `setUrgentFlag` línea 139; agregar campo a `mapConversationDoc`, línea 252)
- Modify: `server/src/services/notifications.service.js` (import + llamada en `sendBulkOrders`, líneas 3-5 y ~161)

**Interfaces:**
- Produces: `export async function markNotified(contactId)` en `conversation.service.js` → `Promise<void>`, actualiza `{ notifiedAt: new Date(), updatedAt: new Date() }` en el doc de conversación. `mapConversationDoc` ahora devuelve también `notifiedAt` (Firestore Timestamp o `null`) en el objeto `ConversationSummary` que ya consumen `listConversations`/`listArchivedConversations`/`searchConversations` — este campo es lo que consume Task 2 en el frontend.

- [ ] **Step 1: Agregar `markNotified` en `conversation.service.js`**

Insertar inmediatamente después del cierre de `setUrgentFlag` (después de la línea 139, `}`):

```js
export async function markNotified(contactId) {
  const db = getDb();
  await db.collection(COLLECTION).doc(contactId).update({
    notifiedAt: new Date(),
    updatedAt: new Date(),
  });
}
```

- [ ] **Step 2: Exponer `notifiedAt` en `mapConversationDoc`**

En el mismo archivo, en el objeto devuelto por `mapConversationDoc` (línea 252), agregar la línea `notifiedAt` justo debajo de `lastClientMessageAt`:

```js
    lastClientMessageAt: data.lastClientMessageAt ?? null,
    notifiedAt: data.notifiedAt ?? null,
```

- [ ] **Step 3: Importar `markNotified` en `notifications.service.js`**

Modificar el import existente (línea 5):

Old:
```js
import { getOrCreateConversation, appendMessage, updateMessageStatus } from './conversation.service.js';
```

New:
```js
import { getOrCreateConversation, appendMessage, updateMessageStatus, markNotified } from './conversation.service.js';
```

- [ ] **Step 4: Llamar `markNotified` solo en envíos exitosos**

En `sendBulkOrders`, dentro del bloque `try` que ya existe (línea ~147), modificar el punto donde se registra el éxito (línea 161):

Old:
```js
      if (sendError) throw sendError;
      results.push({ number: order.number, status: 'sent', phone });
    } catch (err) {
```

New:
```js
      if (sendError) throw sendError;
      await markNotified(phone);
      results.push({ number: order.number, status: 'sent', phone });
    } catch (err) {
```

- [ ] **Step 5: Verificar manualmente contra Firestore real**

Run desde `server/`: `node -e "
import('dotenv/config').then(async () => {
  const { initFirebase } = await import('./src/services/firebase.service.js');
  initFirebase();
  const conv = await import('./src/services/conversation.service.js');
  const TEST_PHONE = '5491100000000'; // reemplazar por un número de prueba real del proyecto
  await conv.getOrCreateConversation(TEST_PHONE, 'whatsapp', 'Test Notificaciones');
  await conv.markNotified(TEST_PHONE);
  const list = await conv.listConversations({});
  const found = list.find(c => c.contactId === TEST_PHONE);
  console.log('notifiedAt seteado:', !!found?.notifiedAt);
  console.log('valor:', found?.notifiedAt);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"`

Expected: no tira error, `notifiedAt seteado: true`, y `valor` muestra un objeto Timestamp con `_seconds` cercano al momento actual.

- [ ] **Step 6: Confirmar que un envío fallido no marca `notifiedAt`**

Revisar a mano el bloque modificado en el Step 4: `markNotified(phone)` está dentro del `try`, **después** de `if (sendError) throw sendError;` — si `sendError` existe, la ejecución nunca llega a `markNotified`, cae directo al `catch` de más abajo. Confirmar leyendo el archivo que el orden de las líneas es exactamente ese (no antes del `if (sendError)`).

- [ ] **Step 7: Commit**

```bash
git add server/src/services/conversation.service.js server/src/services/notifications.service.js
git commit -m "feat(notifications): marcar notifiedAt en la conversación al enviar plantilla masiva exitosa"
```

---

### Task 2: Frontend — chip de filtro "Notificaciones"

**Files:**
- Modify: `client/src/pages/Conversations.jsx`

**Interfaces:**
- Consumes: `notifiedAt` y `lastClientMessageAt` en cada conversación del array `conversations` (ya poblado por `loadConversations`, sin cambios ahí — Task 1 hace que el campo viaje solo). Helper `tsToDate(ts)` ya definido en el archivo (línea 67).
- Produces: comportamiento de UI, no expone nada a otros archivos.

- [ ] **Step 1: Agregar la entrada al array `FILTERS`**

Modificar el array `FILTERS` (líneas 23-31):

Old:
```js
const FILTERS = [
  { value: 'bot',      label: 'Bot' },
  { value: 'mine',     label: 'Mis casos' },
  { value: 'critical', label: '🔴 Crítico' },
  { value: 'urgent',   label: 'Urgentes' },
  { value: 'waiting',  label: 'Esperando ⏳' },
  { value: 'archived', label: 'Archivos' },
  { value: 'teams',    label: 'Equipos',  minRole: 'atencion_cliente' },
];
```

New:
```js
const FILTERS = [
  { value: 'bot',           label: 'Bot' },
  { value: 'mine',          label: 'Mis casos' },
  { value: 'critical',      label: '🔴 Crítico' },
  { value: 'urgent',        label: 'Urgentes' },
  { value: 'waiting',       label: 'Esperando ⏳' },
  { value: 'notifications', label: 'Notificaciones' },
  { value: 'archived',      label: 'Archivos' },
  { value: 'teams',         label: 'Equipos',  minRole: 'atencion_cliente' },
];
```

- [ ] **Step 2: Agregar la rama de filtrado**

En el bloque `filtered` (líneas 764-798), agregar una rama `else if (filter === 'notifications')` después de la rama `else if (filter === 'all')` (línea 792-794):

Old:
```js
        } else if (filter === 'all') {
          if (isConvArchived) return false;
        }

        if (labelFilter && !(c.labels ?? []).includes(labelFilter)) return false;
        return true;
      });
```

New:
```js
        } else if (filter === 'all') {
          if (isConvArchived) return false;
        } else if (filter === 'notifications') {
          if (isConvArchived) return false;
          if (!c.notifiedAt) return false;
          const notifiedAt = tsToDate(c.notifiedAt);
          const lastClientMsg = tsToDate(c.lastClientMessageAt);
          if (notifiedAt && lastClientMsg && lastClientMsg >= notifiedAt) return false;
        }

        if (labelFilter && !(c.labels ?? []).includes(labelFilter)) return false;
        return true;
      });
```

- [ ] **Step 3: Probar manualmente en el navegador**

Run: `cd server && npm run dev` y `cd client && npm run dev` (cada uno en su propia terminal/background).

Casos a probar a mano:
1. Ir a la página de Notificaciones, mandar una plantilla de prueba a un número de test (o usar el número de prueba del Step 5 de Task 1, si sigue en Firestore).
2. Ir a Conversaciones → chip "Notificaciones" → el chat de ese número aparece en la lista.
3. Como agente, responderle al cliente simulando su respuesta (o mandar un mensaje entrante de prueba si el proyecto tiene forma de simularlo) → confirmar que el `lastClientMessageAt` se actualiza y el chat **desaparece** del filtro "Notificaciones" sin recargar la página (el polling de `loadConversations` corre cada 10s).
4. Confirmar que las demás pestañas (Bot, Mis casos, Crítico, Urgentes, Esperando, Archivos, Equipos, Todos) siguen comportándose exactamente igual que antes de este cambio.
5. Confirmar que una conversación con plantilla enviada pero **sin** respuesta del cliente sigue apareciendo en "Notificaciones" después de refrescar la página (el campo persiste en Firestore, no es solo estado en memoria).

Expected: los 5 casos se cumplen sin errores en la consola del navegador.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Conversations.jsx
git commit -m "feat(conversations): agregar filtro Notificaciones para chats abiertos por plantillas masivas sin responder"
```
