# Preview de mensaje citado (reply de WhatsApp) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando un cliente responde citando (swipe-reply) un mensaje anterior de WhatsApp —del bot, de un agente, o de sí mismo— mostrar en el panel de Conversaciones un preview de ese mensaje citado, para que el agente no pierda el contexto.

**Architecture:** Cuatro cambios encadenados: (1) `meta.service.js` parsea el campo `context.id` de WhatsApp, (2) `conversation.service.js` guarda el id de WhatsApp también en mensajes entrantes (hoy solo se guardaba en salientes), (3) `bot.service.js` resuelve un snapshot del mensaje citado (texto truncado + rol) al momento de guardar el mensaje nuevo, y (4) `Conversations.jsx` renderiza ese snapshot como un recuadro citado arriba del mensaje, estilo WhatsApp nativo.

**Tech Stack:** Node.js (ESM) + Express + Firestore (backend), React + Vite (frontend). Sin framework de testing en este repo — verificación con `node -e` scripts contra Firestore real (contacto de prueba `5491100000099`, nunca contra clientes reales) y `npm run build` + prueba manual en el navegador para el frontend.

## Global Constraints

- Instagram queda fuera de alcance (spec, sección "Fuera de alcance").
- Sin click-to-scroll en el recuadro citado — solo texto, no interactivo.
- Sin backfill de `replyTo` en mensajes ya guardados antes de este cambio.
- No enviar mensajes reales de WhatsApp durante la verificación — usar el contacto de prueba `5491100000099` y limpiarlo al final de cada task que lo use.
- Spec de referencia: `docs/superpowers/specs/2026-08-14-preview-mensaje-citado-design.md`.

---

### Task 1: Parsear `context.id` en `parseWhatsAppMessage`

**Files:**
- Modify: `server/src/services/meta.service.js:301-343` (función `parseWhatsAppMessage`)

**Interfaces:**
- Produces: el objeto devuelto por `parseWhatsAppMessage` gana un campo nuevo `replyToWaMsgId: string | null`, además de los campos existentes (`channel`, `from`, `messageId`, `text`, `type`, `mediaId`/`interactiveId`, `timestamp`, `contactName`).

- [ ] **Step 1: Agregar `replyToWaMsgId` a los dos `return` de la función**

Old:
```js
export function parseWhatsAppMessage(webhookBody) {
  try {
    const entry = webhookBody.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value?.messages?.[0]) return null;

    const msg = value.messages[0];
    const contactName = value.contacts?.[0]?.profile?.name ?? 'Cliente';

    if (msg.type === 'interactive') {
      const reply = msg.interactive?.list_reply ?? msg.interactive?.button_reply;
      return {
        channel: 'whatsapp',
        from: msg.from,
        messageId: msg.id,
        text: reply?.title ?? '',
        type: 'interactive',
        interactiveId: reply?.id ?? null,
        mediaId: null,
        timestamp: msg.timestamp,
        contactName,
      };
    }

    const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
    const mediaId = MEDIA_TYPES.includes(msg.type) ? msg[msg.type]?.id : null;
    const caption = MEDIA_TYPES.includes(msg.type) ? (msg[msg.type]?.caption ?? '') : '';

    return {
      channel: 'whatsapp',
      from: msg.from,
      messageId: msg.id,
      text: msg.text?.body ?? caption,
      type: msg.type,
      mediaId,
      timestamp: msg.timestamp,
      contactName,
    };
  } catch {
    return null;
  }
}
```

New:
```js
export function parseWhatsAppMessage(webhookBody) {
  try {
    const entry = webhookBody.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value?.messages?.[0]) return null;

    const msg = value.messages[0];
    const contactName = value.contacts?.[0]?.profile?.name ?? 'Cliente';
    const replyToWaMsgId = msg.context?.id ?? null;

    if (msg.type === 'interactive') {
      const reply = msg.interactive?.list_reply ?? msg.interactive?.button_reply;
      return {
        channel: 'whatsapp',
        from: msg.from,
        messageId: msg.id,
        text: reply?.title ?? '',
        type: 'interactive',
        interactiveId: reply?.id ?? null,
        mediaId: null,
        timestamp: msg.timestamp,
        contactName,
        replyToWaMsgId,
      };
    }

    const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
    const mediaId = MEDIA_TYPES.includes(msg.type) ? msg[msg.type]?.id : null;
    const caption = MEDIA_TYPES.includes(msg.type) ? (msg[msg.type]?.caption ?? '') : '';

    return {
      channel: 'whatsapp',
      from: msg.from,
      messageId: msg.id,
      text: msg.text?.body ?? caption,
      type: msg.type,
      mediaId,
      timestamp: msg.timestamp,
      contactName,
      replyToWaMsgId,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verificar con un webhook body simulado, con y sin cita**

Run desde `server/`:
```bash
node -e "
import('./src/services/meta.service.js').then(({ parseWhatsAppMessage }) => {
  const withReply = parseWhatsAppMessage({
    entry: [{ changes: [{ value: {
      messages: [{ id: 'wamid.NEW', from: '5491112345678', type: 'text', timestamp: '1700000000',
        text: { body: 'El blanco, dale' }, context: { id: 'wamid.ORIGINAL' } }],
      contacts: [{ profile: { name: 'Test' } }],
    } }] }],
  });
  const withoutReply = parseWhatsAppMessage({
    entry: [{ changes: [{ value: {
      messages: [{ id: 'wamid.NEW2', from: '5491112345678', type: 'text', timestamp: '1700000000',
        text: { body: 'Hola' } }],
      contacts: [{ profile: { name: 'Test' } }],
    } }] }],
  });
  console.log('con cita ->', withReply.replyToWaMsgId);
  console.log('sin cita ->', withoutReply.replyToWaMsgId);
  if (withReply.replyToWaMsgId !== 'wamid.ORIGINAL') throw new Error('FALLA: no detectó la cita');
  if (withoutReply.replyToWaMsgId !== null) throw new Error('FALLA: detectó una cita que no existe');
  console.log('OK');
});
"
```
Expected: imprime `con cita -> wamid.ORIGINAL`, `sin cita -> null`, `OK`.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/meta.service.js
git commit -m "feat(webhook): parsear context.id de mensajes citados de WhatsApp"
```

---

### Task 2: Guardar el id de WhatsApp en mensajes entrantes

**Files:**
- Modify: `server/src/services/conversation.service.js:48-90` (función `appendMessage`)

**Interfaces:**
- Consumes: `message.messageId` (opcional, provisto por quien llama — Task 3 lo va a pasar).
- Produces: cuando `message.role === 'user'` y `message.messageId` está presente, el mensaje guardado en Firestore tiene `waMsgId` (mismo nombre de campo que ya usan los mensajes salientes vía `updateMessageStatus`). El campo `messageId` no se persiste tal cual — se renombra a `waMsgId` para mensajes de usuario.

- [ ] **Step 1: Renombrar `messageId` → `waMsgId` al guardar**

Old:
```js
export async function appendMessage(contactId, message) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);

  const doc = await docRef.get();
  const docData = doc.exists ? doc.data() : {};
  const current = docData.messages ?? [];
  const updated = [...current, { ...message, timestamp: new Date() }].slice(-200);
```

New:
```js
export async function appendMessage(contactId, message) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);

  const doc = await docRef.get();
  const docData = doc.exists ? doc.data() : {};
  const current = docData.messages ?? [];
  const { messageId, ...rest } = message;
  const stored = { ...rest, timestamp: new Date() };
  if (message.role === 'user' && messageId) stored.waMsgId = messageId;
  const updated = [...current, stored].slice(-200);
```

(El resto de la función —el bloque `extra` que calcula `unread`, `critical`, etc., y el `docRef.update` final— no cambia. Ese bloque sigue leyendo `message.role`, que `rest`/`stored` conservan sin problema.)

- [ ] **Step 2: Verificar contra Firestore real con el contacto de prueba**

Run desde `server/`:
```bash
node -e "
import('dotenv/config').then(async () => {
  const { initFirebase, getDb } = await import('./src/services/firebase.service.js');
  initFirebase();
  const { appendMessage } = await import('./src/services/conversation.service.js');
  const TEST_PHONE = '5491100000099';

  await appendMessage(TEST_PHONE, { role: 'user', content: 'hola', contactName: 'Test', messageId: 'wamid.INCOMING_TEST' });
  await appendMessage(TEST_PHONE, { role: 'assistant', content: 'hola, en qué te ayudo?' });

  const doc = await getDb().collection('bot-altorancho_conversations').doc(TEST_PHONE).get();
  const msgs = doc.data().messages;
  console.log(JSON.stringify(msgs, null, 2));

  if (msgs[0].waMsgId !== 'wamid.INCOMING_TEST') throw new Error('FALLA: no guardó waMsgId en mensaje de usuario');
  if ('messageId' in msgs[0]) throw new Error('FALLA: quedó el campo messageId sin renombrar');
  if ('waMsgId' in msgs[1]) throw new Error('FALLA: el mensaje assistant no debería tener waMsgId (no se le pasó messageId)');

  await getDb().collection('bot-altorancho_conversations').doc(TEST_PHONE).delete();
  console.log('OK — limpio');
});
"
```
Expected: imprime los dos mensajes guardados, sin errores de `FALLA`, termina en `OK — limpio`.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/conversation.service.js
git commit -m "fix(conversations): guardar waMsgId también en mensajes entrantes"
```

---

### Task 3: Resolver el preview del mensaje citado al guardar

**Files:**
- Modify: `server/src/services/bot.service.js:344-345` (destructuring de `msg`)
- Modify: `server/src/services/bot.service.js` (nuevo helper `resolveReplyTo`, cerca del inicio de `processIncomingMessageInternal`)
- Modify: `server/src/services/bot.service.js:399-493` (los 8 call-sites de `appendMessage({ role: 'user', ... })`)

**Interfaces:**
- Consumes: `history` (array ya cargado por `getConversationHistory(from)`, cada mensaje puede tener `waMsgId`), `msg.replyToWaMsgId` y `msg.messageId` (Task 1).
- Produces: helper privado `resolveReplyTo(history, replyToWaMsgId)` → `{ preview: string, role: string } | null`. Cada mensaje de usuario guardado incluye `messageId` (consumido por Task 2) y, cuando corresponde, `replyTo`.

- [ ] **Step 1: Agregar `messageId` y `replyToWaMsgId` al destructuring de `msg`**

Old:
```js
async function processIncomingMessageInternal(msg) {
  const { channel, from, text, type, mediaId, mediaUrl, contactName } = msg;
```

New:
```js
async function processIncomingMessageInternal(msg) {
  const { channel, from, text, type, mediaId, mediaUrl, contactName, messageId, replyToWaMsgId } = msg;
```

- [ ] **Step 2: Agregar el helper `resolveReplyTo` y calcular `replyTo` una sola vez**

Insertar el helper como función privada, inmediatamente antes de `async function processIncomingMessageInternal(msg) {` (línea 344):

```js
const REPLY_PREVIEW_MAX = 80;

// Snapshot del mensaje citado (texto + rol) al momento de la cita — no una
// referencia viva. Si el mensaje citado no está en el historial (se recortó
// de los últimos 200, o es de antes de este cambio), no rompe nada: se
// guarda el mensaje nuevo sin `replyTo`.
function resolveReplyTo(history, replyToWaMsgId) {
  if (!replyToWaMsgId) return null;
  const original = history.find(m => m.waMsgId === replyToWaMsgId);
  if (!original) return null;
  const content = original.content ?? '';
  const preview = content.length > REPLY_PREVIEW_MAX
    ? `${content.slice(0, REPLY_PREVIEW_MAX)}…`
    : content;
  return { preview, role: original.role };
}

async function processIncomingMessageInternal(msg) {
```

Dentro de `processIncomingMessageInternal`, inmediatamente después del bloque `const botConfig = ...` / `console.log('[bot] Contexto cargado...')` (~línea 362-363), agregar:

```js
  const replyTo = resolveReplyTo(history, replyToWaMsgId);
```

- [ ] **Step 3: Pasar `messageId` y `replyTo` en los 8 call-sites de mensajes de usuario**

Old (bloque humanMode, ~línea 399-408):
```js
      await appendMessage(from, {
        role: 'user',
        content: contentMap[type],
        mediaType: type,
        mediaId: mediaId ?? null,
        contactName,
      });
    } else if (text?.trim()) {
      await appendMessage(from, { role: 'user', content: text, contactName });
    }
```

New:
```js
      await appendMessage(from, {
        role: 'user',
        content: contentMap[type],
        mediaType: type,
        mediaId: mediaId ?? null,
        contactName,
        messageId,
        ...(replyTo && { replyTo }),
      });
    } else if (text?.trim()) {
      await appendMessage(from, { role: 'user', content: text, contactName, messageId, ...(replyTo && { replyTo }) });
    }
```

Old (menú guiado, ~línea 417-418):
```js
      if (text?.trim()) {
        await appendMessage(from, { role: 'user', content: text, contactName });
      }
```

New:
```js
      if (text?.trim()) {
        await appendMessage(from, { role: 'user', content: text, contactName, messageId, ...(replyTo && { replyTo }) });
      }
```

Old (interactive, ~línea 432):
```js
    await appendMessage(from, { role: 'user', content: text || '(selección de menú)', contactName });
```

New:
```js
    await appendMessage(from, { role: 'user', content: text || '(selección de menú)', contactName, messageId, ...(replyTo && { replyTo }) });
```

Old (audio, ~línea 447):
```js
    await appendMessage(from, { role: 'user', content: audioUserMsg, mediaType: 'audio', mediaId: mediaId ?? null, contactName });
```

New:
```js
    await appendMessage(from, { role: 'user', content: audioUserMsg, mediaType: 'audio', mediaId: mediaId ?? null, contactName, messageId, ...(replyTo && { replyTo }) });
```

Old (documento, ~línea 470):
```js
    await appendMessage(from, { role: 'user', content: '[Archivo recibido]', mediaType: 'document', mediaId: mediaId ?? null, contactName });
```

New:
```js
    await appendMessage(from, { role: 'user', content: '[Archivo recibido]', mediaType: 'document', mediaId: mediaId ?? null, contactName, messageId, ...(replyTo && { replyTo }) });
```

Old (imagen + fallback de texto plano, ~línea 489-493):
```js
    const userContent = text?.trim() ? `[Imagen] ${text}` : '[Imagen recibida]';
    await appendMessage(from, { role: 'user', content: userContent, mediaType: 'image', mediaId: mediaId ?? null, contactName });
  } else {
    if (!text?.trim()) return;
    await appendMessage(from, { role: 'user', content: text, contactName });
  }
```

New:
```js
    const userContent = text?.trim() ? `[Imagen] ${text}` : '[Imagen recibida]';
    await appendMessage(from, { role: 'user', content: userContent, mediaType: 'image', mediaId: mediaId ?? null, contactName, messageId, ...(replyTo && { replyTo }) });
  } else {
    if (!text?.trim()) return;
    await appendMessage(from, { role: 'user', content: text, contactName, messageId, ...(replyTo && { replyTo }) });
  }
```

- [ ] **Step 4: Verificar el flujo completo contra Firestore real**

El camino más determinístico para probar esto sin mandar mensajes reales de WhatsApp ni llamar a Claude es el de `humanMode: true` (línea ~389-411): guarda el mensaje del usuario y devuelve, sin tocar la API de Meta ni Claude.

Run desde `server/`:
```bash
node -e "
import('dotenv/config').then(async () => {
  const { initFirebase, getDb } = await import('./src/services/firebase.service.js');
  initFirebase();
  const { processIncomingMessage } = await import('./src/services/bot.service.js');
  const TEST_PHONE = '5491100000099';

  await getDb().collection('bot-altorancho_conversations').doc(TEST_PHONE).set({
    contactId: TEST_PHONE, channel: 'whatsapp', contactName: 'Test Reply',
    messages: [{ role: 'assistant', content: 'Tenemos el modelo en negro y en blanco, ¿cuál preferís?', waMsgId: 'wamid.TEST_ORIGINAL', timestamp: new Date() }],
    status: 'escalated', humanMode: true, assignedTo: 'agente@test.com', urgent: false, unread: 0,
    consecutiveClientMessages: 0, lastClientMessageAt: null, menuShown: false, pendingMenuTopic: null,
    pendingLocalStore: null, createdAt: new Date(), updatedAt: new Date(),
  });

  await processIncomingMessage({
    channel: 'whatsapp', from: TEST_PHONE, text: 'El blanco, dale', type: 'text',
    mediaId: null, mediaUrl: null, timestamp: String(Math.floor(Date.now() / 1000)),
    contactName: 'Test Reply', messageId: 'wamid.TEST_REPLY', replyToWaMsgId: 'wamid.TEST_ORIGINAL',
  });

  // processIncomingMessage encola por contactId — dar margen a que termine el append.
  await new Promise(r => setTimeout(r, 500));

  const doc = await getDb().collection('bot-altorancho_conversations').doc(TEST_PHONE).get();
  const msgs = doc.data().messages;
  const last = msgs[msgs.length - 1];
  console.log(JSON.stringify(last, null, 2));

  if (last.waMsgId !== 'wamid.TEST_REPLY') throw new Error('FALLA: no guardó el waMsgId propio');
  if (!last.replyTo) throw new Error('FALLA: no resolvió replyTo');
  if (last.replyTo.role !== 'assistant') throw new Error('FALLA: replyTo.role incorrecto');
  if (last.replyTo.preview !== 'Tenemos el modelo en negro y en blanco, ¿cuál preferís?') throw new Error('FALLA: preview incorrecto');

  await getDb().collection('bot-altorancho_conversations').doc(TEST_PHONE).delete();
  await getDb().collection('bot-altorancho_customers').doc(TEST_PHONE).delete().catch(() => {});
  console.log('OK — limpio');
});
"
```
Expected: imprime el último mensaje con `waMsgId: 'wamid.TEST_REPLY'` y `replyTo: { preview: 'Tenemos el modelo en negro y en blanco, ¿cuál preferís?', role: 'assistant' }`, sin `FALLA`, termina en `OK — limpio`.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/bot.service.js
git commit -m "feat(bot): resolver preview del mensaje citado al guardar mensajes entrantes"
```

---

### Task 4: Mostrar el preview citado en el chat

**Files:**
- Modify: `client/src/pages/Conversations.jsx` (componente `MessageBubble`, ~línea 159-258)
- Modify: `client/src/pages/Conversations.module.css` (nuevas clases, después de `.msgBot .msgBubble`)

**Interfaces:**
- Consumes: `msg.replyTo` (`{ preview: string, role: 'user' | 'assistant' | 'admin' } | undefined`, provisto por Task 3).

- [ ] **Step 1: Agregar el mapeo de roles y el bloque JSX del recuadro citado**

Old (justo antes de `function MessageBubble`, ~línea 159):
```js
function MessageBubble({ msg, onRetry, contactId }) {
```

New:
```js
const REPLY_ROLE_LABELS = { user: 'Cliente', admin: 'Agente', assistant: 'Alto' };

function MessageBubble({ msg, onRetry, contactId }) {
```

Old (apertura de la burbuja, ~línea 189):
```js
      <div className={`${styles.msgBubble} ${isError ? styles.msgBubbleError : ''}`}>
        {msg.mediaType === 'image' && mediaProxyUrl && (
```

New:
```js
      <div className={`${styles.msgBubble} ${isError ? styles.msgBubbleError : ''}`}>
        {msg.replyTo && (
          <div className={styles.msgReplyQuote}>
            <span className={styles.msgReplyQuoteFrom}>{REPLY_ROLE_LABELS[msg.replyTo.role] ?? ''}</span>
            <span className={styles.msgReplyQuoteText}>{msg.replyTo.preview}</span>
          </div>
        )}
        {msg.mediaType === 'image' && mediaProxyUrl && (
```

- [ ] **Step 2: Agregar los estilos del recuadro citado**

En `client/src/pages/Conversations.module.css`, insertar después del bloque `.msgBot .msgBubble` (~línea 440, antes de `.msgMeta`):

Old:
```css
.msgBot .msgBubble {
  background: var(--color-primary);
  color: #fff;
  border-bottom-right-radius: var(--radius-sm);
}

.msgMeta {
```

New:
```css
.msgBot .msgBubble {
  background: var(--color-primary);
  color: #fff;
  border-bottom-right-radius: var(--radius-sm);
}

.msgReplyQuote {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px var(--space-2);
  margin-bottom: var(--space-1);
  border-left: 3px solid currentColor;
  border-radius: var(--radius-sm);
  background: rgba(127, 127, 127, 0.15);
  opacity: 0.85;
}
.msgReplyQuoteFrom {
  font-size: 10px;
  font-weight: 600;
}
.msgReplyQuoteText {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msgMeta {
```

- [ ] **Step 3: Build para verificar sintaxis**

Run: `cd client && npm run build`
Expected: build exitoso, sin errores.

- [ ] **Step 4: Sembrar datos de prueba y verificar visualmente**

Con el backend corriendo (`cd server && npm run dev`) y Firestore accesible, sembrar una conversación de prueba con un mensaje citado ya resuelto (reusa el mismo `TEST_PHONE` de Task 3 — si ya lo limpiaste ahí, se recrea acá).

Run desde `server/` (en otra terminal, sin frenar `npm run dev`):
```bash
node -e "
import('dotenv/config').then(async () => {
  const { initFirebase, getDb } = await import('./src/services/firebase.service.js');
  initFirebase();
  const TEST_PHONE = '5491100000099';
  await getDb().collection('bot-altorancho_conversations').doc(TEST_PHONE).set({
    contactId: TEST_PHONE, channel: 'whatsapp', contactName: 'Test Reply',
    messages: [
      { role: 'assistant', content: 'Tenemos el modelo en negro y en blanco, ¿cuál preferís?', waMsgId: 'wamid.TEST_ORIGINAL', timestamp: new Date() },
      { role: 'user', content: 'El blanco, dale', waMsgId: 'wamid.TEST_REPLY', replyTo: { preview: 'Tenemos el modelo en negro y en blanco, ¿cuál preferís?', role: 'assistant' }, timestamp: new Date() },
    ],
    status: 'escalated', humanMode: true, assignedTo: 'agente@test.com', urgent: false, unread: 0,
    consecutiveClientMessages: 0, lastClientMessageAt: null, menuShown: false, pendingMenuTopic: null,
    pendingLocalStore: null, createdAt: new Date(), updatedAt: new Date(),
  });
  console.log('sembrado');
});
"
```

Con `npm run dev` corriendo (server + client), abrir Conversaciones en el navegador, buscar/seleccionar el contacto `5491100000099` ("Test Reply") y confirmar que el segundo mensaje ("El blanco, dale") muestra arriba un recuadro citado con borde izquierdo, la etiqueta "Alto" y el texto "Tenemos el modelo en negro y en blanco, ¿cuál preferís?". Confirmar también que mensajes sin `replyTo` (cualquier otro chat) siguen viéndose igual que antes, sin el recuadro.

- [ ] **Step 5: Limpiar la conversación de prueba**

```bash
node -e "
import('dotenv/config').then(async () => {
  const { initFirebase, getDb } = await import('./src/services/firebase.service.js');
  initFirebase();
  const TEST_PHONE = '5491100000099';
  await getDb().collection('bot-altorancho_conversations').doc(TEST_PHONE).delete();
  await getDb().collection('bot-altorancho_customers').doc(TEST_PHONE).delete().catch(() => {});
  console.log('limpio');
});
"
```
Run desde `server/`.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Conversations.jsx client/src/pages/Conversations.module.css
git commit -m "feat(conversations): mostrar preview del mensaje citado en el chat"
```
