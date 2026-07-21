# Guided WhatsApp Menu Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, button/list-driven entry flow to BOT-ALTORANCHO's WhatsApp channel that runs before Claude, gathers structured intent (topic, web/local, order number/SKU), and either continues into the existing freeform Claude pipeline or escalates directly — gated behind a `bot_config.flowMode` toggle so it never affects production traffic until explicitly turned on.

**Architecture:** `meta.service.js` gains two new senders (`sendWhatsAppInteractiveList`, `sendWhatsAppInteractiveButtons`) and `parseWhatsAppMessage` learns to decode incoming button/list taps into `{ type: 'interactive', interactiveId, text }`. `bot.service.js` intercepts the first message of a new/reopened conversation (when `flowMode === 'menu'`) to send the entry list instead of calling Claude, and intercepts `type === 'interactive'` messages to branch by `interactiveId`. Every branch bottoms out in code that already exists today (`resolveOrderContext`, `resolveStockContext`, `dispatchConversation`, `generateBotResponse`) — the menu's only job is to produce clean, unambiguous input for that existing pipeline.

**Tech Stack:** Node.js (ESM), Express, Firebase Admin SDK (Firestore), WhatsApp Cloud API (Meta Graph API v20.0), Anthropic Claude API. No test framework is configured in this project (`server/package.json` has no `test` script) — verification throughout this plan uses `node --check` for syntax and small throwaway Node scripts (matching the existing `server/scripts/*.mjs` convention already used in this repo) that talk to the real Firestore/TiendaNube/Odoo services via `.env` credentials, plus manual HTTP calls to the existing `POST /api/test/message` route for integration-level checks.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-21-guided-menu-flow-design.md` — every requirement in this plan traces back to a decision made there.
- Zero behavior change when `bot_config.flowMode` is unset or `'freeform'` (the default) — this is the most important constraint, verified explicitly in Task 7.
- WhatsApp interactive list row `title` max 24 characters, row `description` max 72 characters (Meta Graph API hard limit) — row titles used in this plan are all well under that, but any future edits to copy must respect it.
- WhatsApp interactive button messages support a maximum of 3 buttons — the "web/local" sub-question uses exactly 2, so this is not at risk, but don't grow that list past 3 without switching to a list message.
- Instagram is explicitly out of scope for this iteration — the menu logic must only trigger for `channel === 'whatsapp'`.
- Reuse existing functions rather than duplicating logic: `resolveOrderContext`, `resolveStockContext`, `dispatchConversation`, `buildEscalationMessage`, `getActiveDepartments`, `generateBotResponse`. Do not fork copies of these.

---

## Task 1: Interactive message support in `meta.service.js`

**Files:**
- Modify: `server/src/services/meta.service.js`
- Test (throwaway, deleted at end of task): `server/scripts/verify-interactive-parse.mjs`

**Interfaces:**
- Produces: `sendWhatsAppInteractiveList(to: string, bodyText: string, buttonText: string, sections: Array<{title: string, rows: Array<{id: string, title: string, description?: string}>}>): Promise<string|null>`
- Produces: `sendWhatsAppInteractiveButtons(to: string, bodyText: string, buttons: Array<{id: string, title: string}>): Promise<string|null>`
- Produces: `parseWhatsAppMessage` now also returns, for interactive replies: `{ channel: 'whatsapp', from, messageId, text: <tapped title>, type: 'interactive', interactiveId: <tapped id>, mediaId: null, timestamp, contactName }`

- [ ] **Step 1: Write the verification script**

Create `server/scripts/verify-interactive-parse.mjs`:

```js
import { parseWhatsAppMessage } from '../src/services/meta.service.js';

function makeWebhook(messageOverrides) {
  return {
    entry: [{
      changes: [{
        value: {
          contacts: [{ profile: { name: 'Cliente Test' } }],
          messages: [{
            from: '5491100000000',
            id: 'wamid.TEST123',
            timestamp: '1700000000',
            ...messageOverrides,
          }],
        },
      }],
    }],
  };
}

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`${pass ? 'OK' : 'FALLA'}  ${label}`);
  if (!pass) {
    console.log('  esperado:', JSON.stringify(expected));
    console.log('  obtenido:', JSON.stringify(actual));
  }
}

// list_reply
const listResult = parseWhatsAppMessage(makeWebhook({
  type: 'interactive',
  interactive: { type: 'list_reply', list_reply: { id: 'menu_order_status', title: 'Estado de pedido' } },
}));
check('list_reply → interactiveId', listResult.interactiveId, 'menu_order_status');
check('list_reply → type', listResult.type, 'interactive');
check('list_reply → text (usa el title)', listResult.text, 'Estado de pedido');

// button_reply
const buttonResult = parseWhatsAppMessage(makeWebhook({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id: 'web', title: 'Por la web' } },
}));
check('button_reply → interactiveId', buttonResult.interactiveId, 'web');
check('button_reply → text', buttonResult.text, 'Por la web');

// texto plano sigue funcionando igual que antes
const textResult = parseWhatsAppMessage(makeWebhook({ type: 'text', text: { body: 'hola' } }));
check('texto plano → type', textResult.type, 'text');
check('texto plano → text', textResult.text, 'hola');
check('texto plano → interactiveId no debe existir', textResult.interactiveId, undefined);

console.log(failures === 0 ? '\nTodos los casos pasaron' : `\n${failures} caso(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it against the current code, confirm it fails**

```bash
cd server && node scripts/verify-interactive-parse.mjs
```

Expected: no crash, but several `FALLA` lines and a non-zero exit — today's `parseWhatsAppMessage` doesn't special-case `msg.type === 'interactive'`, so it falls through to the generic return: `type` comes back as `'interactive'` (unchanged from input, so that one line coincidentally reads `OK`), but `interactiveId` is `undefined` (the field doesn't exist yet) and `text` is `''` (there's no `msg.text.body` on an interactive payload). So `list_reply → interactiveId`, `list_reply → text`, `button_reply → interactiveId`, and `button_reply → text` all print `FALLA`, and the script ends with `4 caso(s) fallaron` and exit code 1.

- [ ] **Step 3: Add the two new send functions**

In `server/src/services/meta.service.js`, add right after `sendWhatsAppMessage` (currently ends at line 66, right before `export async function sendInstagramMessage`):

```js
// Returns WA message ID on success, null if tokens not configured
export async function sendWhatsAppInteractiveList(to, bodyText, buttonText, sections) {
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PHONE_NUMBER_ID) {
    console.log('[meta] sendWhatsAppInteractiveList skipped — tokens not configured');
    return null;
  }
  const { data } = await postWithSafeRetry(
    `${META_API_URL}/${process.env.META_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: { button: buttonText, sections },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return data.messages?.[0]?.id ?? null;
}

// Returns WA message ID on success, null if tokens not configured
export async function sendWhatsAppInteractiveButtons(to, bodyText, buttons) {
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PHONE_NUMBER_ID) {
    console.log('[meta] sendWhatsAppInteractiveButtons skipped — tokens not configured');
    return null;
  }
  const { data } = await postWithSafeRetry(
    `${META_API_URL}/${process.env.META_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return data.messages?.[0]?.id ?? null;
}
```

(These two aren't exercised by the verification script — there's no live Meta credential in a throwaway test run, and `postWithSafeRetry` talking to the real Graph API isn't something to unit-test. They're verified end-to-end in Task 3 Step 8 onward, once they're wired into a real flow.)

- [ ] **Step 4: Extend `parseWhatsAppMessage` to decode interactive replies**

Replace the current `parseWhatsAppMessage` (lines 233-259 of `server/src/services/meta.service.js`):

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

This is a refactor of the existing function (pulled `contactName` out once, added the `interactive` branch) — behavior for every existing message type (`text`, `image`, `audio`, `video`, `document`, `sticker`) is unchanged.

- [ ] **Step 5: Run the verification script again, confirm it passes**

```bash
cd server && node scripts/verify-interactive-parse.mjs
```

Expected output ends with:
```
Todos los casos pasaron
```

- [ ] **Step 6: Syntax-check and clean up**

```bash
cd server && node --check src/services/meta.service.js && rm scripts/verify-interactive-parse.mjs
```

- [ ] **Step 7: Commit**

```bash
git add server/src/services/meta.service.js
git commit -m "$(cat <<'EOF'
Add WhatsApp interactive list/button send + parse support

Foundation for the guided menu flow: meta.service.js can now send
list and button messages and decode incoming taps into a normalized
{type: 'interactive', interactiveId, text} shape, alongside the
existing plain-text/media handling (unchanged).
EOF
)"
```

---

## Task 2: Menu state on the conversation document (`conversation.service.js`)

**Files:**
- Modify: `server/src/services/conversation.service.js`
- Test (throwaway, deleted at end of task): `server/scripts/verify-menu-state.mjs`

**Interfaces:**
- Consumes: nothing new (uses existing `getDb()` pattern already in this file).
- Produces: `getOrCreateConversation(...)` now includes `menuShown: false, pendingMenuTopic: null` in the defaults for brand-new conversations.
- Produces: `setMenuState(contactId: string, { menuShown?: boolean, pendingMenuTopic?: string|null }): Promise<void>`

- [ ] **Step 1: Write the verification script**

Create `server/scripts/verify-menu-state.mjs`:

```js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initFirebase } from '../src/services/firebase.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
initFirebase();

const { getOrCreateConversation, setMenuState } = await import('../src/services/conversation.service.js');
const { getDb } = await import('../src/services/firebase.service.js');

const TEST_CONTACT_ID = 'test_menu_state_verify';

// Limpieza previa por si quedó de una corrida anterior
await getDb().collection('bot-altorancho_conversations').doc(TEST_CONTACT_ID).delete().catch(() => {});

let failures = 0;
function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'OK' : 'FALLA'}  ${label} (esperado=${expected}, obtenido=${actual})`);
}

const created = await getOrCreateConversation(TEST_CONTACT_ID, 'whatsapp', 'Test Menu State');
check('nueva conversación → menuShown default', created.menuShown, false);
check('nueva conversación → pendingMenuTopic default', created.pendingMenuTopic, null);

await setMenuState(TEST_CONTACT_ID, { menuShown: true, pendingMenuTopic: 'order_status' });
const afterSet = await getOrCreateConversation(TEST_CONTACT_ID, 'whatsapp', 'Test Menu State');
check('tras setMenuState → menuShown', afterSet.menuShown, true);
check('tras setMenuState → pendingMenuTopic', afterSet.pendingMenuTopic, 'order_status');

await setMenuState(TEST_CONTACT_ID, { pendingMenuTopic: null });
const afterClear = await getOrCreateConversation(TEST_CONTACT_ID, 'whatsapp', 'Test Menu State');
check('setMenuState parcial → pendingMenuTopic se limpia', afterClear.pendingMenuTopic, null);
check('setMenuState parcial → menuShown no se toca', afterClear.menuShown, true);

// Limpieza final
await getDb().collection('bot-altorancho_conversations').doc(TEST_CONTACT_ID).delete();

console.log(failures === 0 ? '\nTodos los casos pasaron' : `\n${failures} caso(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it against the current code, confirm it fails**

```bash
cd server && node scripts/verify-menu-state.mjs
```

Expected: crashes with `TypeError: setMenuState is not a function` (or similar) — `setMenuState` doesn't exist in `conversation.service.js` yet. (The two `menuShown`/`pendingMenuTopic` default checks right before that would also print `FALLA`, since `getOrCreateConversation` doesn't set those fields yet either — either way, this is a concrete non-passing state.)

- [ ] **Step 3: Add the new default fields**

In `server/src/services/conversation.service.js`, inside `getOrCreateConversation` (currently lines 10-41), the `newConversation` object (lines 23-37):

```js
  const newConversation = {
    contactId,
    channel,
    contactName: contactName ?? null,
    messages: [],
    status: 'bot',
    humanMode: false,
    assignedTo: null,
    urgent: false,
    unread: 0,
    consecutiveClientMessages: 0,
    lastClientMessageAt: null,
    menuShown: false,
    pendingMenuTopic: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
```

(Added `menuShown: false, pendingMenuTopic: null` — two new lines, nothing else in this function changes.)

- [ ] **Step 4: Add `setMenuState`**

Add this new function anywhere among the other single-purpose update functions, e.g. right after `updateAssignment` (currently ends at line 117):

```js
export async function setMenuState(contactId, { menuShown, pendingMenuTopic } = {}) {
  const db = getDb();
  const update = { updatedAt: new Date() };
  if (menuShown !== undefined) update.menuShown = !!menuShown;
  if (pendingMenuTopic !== undefined) update.pendingMenuTopic = pendingMenuTopic;
  await db.collection(COLLECTION).doc(contactId).update(update);
}
```

- [ ] **Step 5: Run the verification script again, confirm it passes**

```bash
cd server && node scripts/verify-menu-state.mjs
```

Expected output ends with:
```
Todos los casos pasaron
```

(This talks to the real Firestore using the credentials in `server/.env` — the same pattern as `server/scripts/find-chat.mjs`/`dump-chat.mjs` used earlier. It creates and deletes its own `test_menu_state_verify` document, so it doesn't touch real customer data.)

- [ ] **Step 6: Syntax-check and clean up**

```bash
cd server && node --check src/services/conversation.service.js && rm scripts/verify-menu-state.mjs
```

- [ ] **Step 7: Commit**

```bash
git add server/src/services/conversation.service.js
git commit -m "$(cat <<'EOF'
Add menuShown/pendingMenuTopic fields to conversation state

Tracks whether the guided menu's entry list has already been shown
for a conversation, and what free-text answer (order number, SKU) is
currently expected — foundation for the menu flow orchestration in
bot.service.js.
EOF
)"
```

---

## Task 3: Show the entry menu on the first message (`bot.service.js` + `test.routes.js`)

**Files:**
- Modify: `server/src/services/bot.service.js`
- Modify: `server/src/routes/test.routes.js`

**Interfaces:**
- Consumes: `setMenuState` from Task 2, `sendWhatsAppInteractiveList` from Task 1.
- Produces: when `botConfig.flowMode === 'menu'` and `channel === 'whatsapp'` and `!conversation.menuShown`, the first message of a conversation gets the entry list instead of a Claude reply, and `conversation.menuShown` becomes `true`.

- [ ] **Step 1: Add the entry-menu constants**

In `server/src/services/bot.service.js`, add after the existing `SKU_PATTERN` constant (currently line 68), before `const URGENCY_KEYWORDS`:

```js
// --- Flujo guiado por menú (bot_config.flowMode === 'menu') ---
const ENTRY_MENU_BODY = '¡Hola! 👋 Elegí una opción para que te pueda ayudar más rápido:';
const ENTRY_MENU_BUTTON_TEXT = 'Ver opciones';
const ENTRY_MENU_SECTIONS = [
  {
    title: 'Alto Rancho',
    rows: [
      { id: 'menu_order_status', title: 'Estado de pedido', description: 'Consultar en qué está tu pedido' },
      { id: 'menu_order_change', title: 'Cambios y devoluciones', description: 'Cambiar o devolver un producto' },
      { id: 'menu_stock', title: 'Stock y productos', description: 'Consultar disponibilidad' },
      { id: 'menu_talk_to_agent', title: 'Hablar con alguien', description: 'Te derivamos con el equipo' },
    ],
  },
];
```

- [ ] **Step 2: Import the new dependency**

In `server/src/services/bot.service.js`, update the `meta.service.js` import (currently line 16):

```js
import { sendWhatsAppMessage, sendInstagramMessage, markWhatsAppAsRead, downloadMediaAsBase64, sendWhatsAppInteractiveList, sendWhatsAppInteractiveButtons } from './meta.service.js';
```

And update the `conversation.service.js` import (currently lines 3-13) to add `setMenuState`:

```js
import {
  getOrCreateConversation,
  appendMessage,
  getConversationHistory,
  updateConversationStatus,
  updateHumanMode,
  updateAssignment,
  dispatchConversation,
  setUrgentFlag,
  addLabelToConversation,
  setMenuState,
} from './conversation.service.js';
```

- [ ] **Step 3: Add the `sendEntryMenu` helper**

Add this function right after `parseLabelMarkers` (currently ends at line 140), before the `contactLocks` comment:

```js
async function sendEntryMenu(to) {
  try {
    const sent = await sendWhatsAppInteractiveList(to, ENTRY_MENU_BODY, ENTRY_MENU_BUTTON_TEXT, ENTRY_MENU_SECTIONS);
    return !!sent;
  } catch (err) {
    console.error('[bot] Error enviando menú de entrada:', err.message);
    return false;
  }
}
```

- [ ] **Step 4: Reset menu state when a conversation is auto-reopened**

In `processIncomingMessageInternal`, the auto-reopen block (currently lines 190-204):

```js
  // Auto-reopen archived/resolved conversations when a new message arrives → always goes to bot
  const isArchived = ['resolved', 'bot_archived'].includes(conversation.status)
    || conversation.status === 'urgent'; // legacy urgent status
  if (isArchived && !conversation.humanMode) {
    const previousStatus = conversation.status;
    await Promise.all([
      updateConversationStatus(from, 'bot'),
      updateHumanMode(from, false),
      updateAssignment(from, null),
      setMenuState(from, { menuShown: false, pendingMenuTopic: null }),
    ]);
    conversation.status = 'bot';
    conversation.humanMode = false;
    conversation.assignedTo = null;
    conversation.menuShown = false;
    conversation.pendingMenuTopic = null;
    console.log(`[bot] Conversación ${from} reabierta automáticamente desde '${previousStatus}'`);
  }
```

(Added `setMenuState(...)` to the `Promise.all` and the two mirrored in-memory field resets.)

- [ ] **Step 5: Intercept the first message to show the menu**

Immediately after the `if (conversation.humanMode) { ... return; }` block (currently ends at line 228) and before the `// --- Non-text type handling ---` comment (currently line 230), insert:

```js
  // --- Menú guiado (flowMode === 'menu') ---
  if (channel === 'whatsapp' && botConfig.flowMode === 'menu' && !conversation.menuShown) {
    if (text?.trim()) {
      await appendMessage(from, { role: 'user', content: text, contactName });
    }
    const sent = await sendEntryMenu(from);
    if (sent) {
      await appendMessage(from, { role: 'assistant', content: ENTRY_MENU_BODY });
      await setMenuState(from, { menuShown: true });
      console.log(`[bot] Menú de entrada enviado a ${from}`);
      return;
    }
    console.warn(`[bot] No se pudo enviar el menú de entrada a ${from} — sigue el flujo normal`);
  }

```

Note: if `sendEntryMenu` fails (e.g. Meta tokens not configured, or a transient error), we deliberately do **not** mark `menuShown: true` and fall through to the normal flow for this one message — this matches the spec's error-handling rule ("si falla el envío del menú, se cae al flujo freeform normal").

- [ ] **Step 6: Let `test.routes.js` simulate interactive taps**

Replace `server/src/routes/test.routes.js` in full:

```js
import { Router } from 'express';
import { processIncomingMessage } from '../services/bot.service.js';
import { getConversationHistory } from '../services/conversation.service.js';
import { getCustomerProfile } from '../services/customer.service.js';

const router = Router();

router.post('/message', async (req, res) => {
  const { contactId, message, channel = 'whatsapp', contactName, type, interactiveId } = req.body;

  if (!contactId || (!message && !interactiveId)) {
    return res.status(400).json({ error: 'contactId y (message o interactiveId) son requeridos' });
  }

  try {
    await processIncomingMessage({
      channel,
      from: contactId,
      messageId: null,
      text: message ?? '',
      type: type ?? undefined,
      interactiveId: interactiveId ?? undefined,
      contactName: contactName ?? `Test-${contactId.slice(-4)}`,
    });

    const [messages, customer] = await Promise.all([
      getConversationHistory(contactId),
      getCustomerProfile(contactId),
    ]);

    const lastBot = [...messages].reverse().find(m => m.role === 'assistant');

    res.json({
      ok: true,
      reply: lastBot?.content ?? null,
      messages: messages.slice(-10),
      customer,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
```

(Adds optional `type`/`interactiveId` passthrough so a test call can simulate a button/list tap; existing plain-text calls — `type` and `interactiveId` both omitted — behave exactly as before.)

- [ ] **Step 7: Syntax-check**

```bash
cd server && node --check src/services/bot.service.js && node --check src/routes/test.routes.js
```

Expected: no output (success).

- [ ] **Step 8: Manual verification — menu appears when `flowMode: 'menu'`**

Start the dev server in one terminal:

```bash
cd server && npm run dev
```

In another terminal, turn the toggle on and send a first message for a brand-new test contact:

```bash
curl -s -X PUT http://localhost:3000/api/config -H "Content-Type: application/json" -d '{"flowMode":"menu"}'

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_menu_flow_001","message":"hola"}'
```

Expected: the JSON response's `reply` field is `null` (no Claude reply — the menu was sent instead, not a normal chat reply), and `messages` includes an `assistant`-role entry with `content` equal to `ENTRY_MENU_BODY` ("¡Hola! 👋 Elegí una opción..."). Server logs show `[bot] Menú de entrada enviado a test_menu_flow_001` (or, if `META_ACCESS_TOKEN`/`META_PHONE_NUMBER_ID` aren't set in this environment, `sendWhatsAppInteractiveList skipped — tokens not configured` followed by the "no se pudo enviar" warning and a normal Claude reply instead — either is consistent with the code, but confirm which one your `.env` produces so you know what to expect in later tasks).

- [ ] **Step 9: Manual verification — `flowMode: 'freeform'` (default) is untouched**

```bash
curl -s -X PUT http://localhost:3000/api/config -H "Content-Type: application/json" -d '{"flowMode":"freeform"}'

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_freeform_regression","message":"hola"}'
```

Expected: `reply` is a normal Claude greeting (non-null), no interactive list is attempted. This confirms the toggle actually gates the new behavior.

- [ ] **Step 10: Clean up test conversations from Firestore**

```bash
cd server && node -e "
import('dotenv/config');
" 2>/dev/null
node --input-type=module -e "
import dotenv from 'dotenv'; dotenv.config();
import { initFirebase, getDb } from './src/services/firebase.service.js';
initFirebase();
await getDb().collection('bot-altorancho_conversations').doc('test_menu_flow_001').delete();
await getDb().collection('bot-altorancho_conversations').doc('test_freeform_regression').delete();
console.log('limpio');
"
```

- [ ] **Step 11: Commit**

```bash
git add server/src/services/bot.service.js server/src/routes/test.routes.js
git commit -m "$(cat <<'EOF'
Send guided entry menu on first message when flowMode is 'menu'

Gated entirely behind bot_config.flowMode (default 'freeform', zero
behavior change). When enabled, the first message of a new/reopened
WhatsApp conversation gets an interactive list instead of a Claude
reply. test.routes.js now accepts type/interactiveId so the flow can
be exercised without a real WhatsApp round-trip.
EOF
)"
```

---

## Task 4: Order status / change branch — web-or-local buttons

**Files:**
- Modify: `server/src/services/bot.service.js`

**Interfaces:**
- Consumes: `conversation.pendingMenuTopic` (Task 2), `sendWhatsAppInteractiveButtons` (Task 1).
- Produces: `handleMenuInteraction(...)` — new function, called from `processIncomingMessageInternal` for `type === 'interactive'` messages. For this task it handles `interactiveId` values `'menu_order_status'`, `'menu_order_change'`, `'web'`, `'local'` and returns `true`; anything else returns `false` (handled fully in Task 6).

- [ ] **Step 1: Add the web/local constants**

Add next to the `ENTRY_MENU_*` constants from Task 3:

```js
const WEB_LOCAL_PROMPT = '¿Fue una compra por la web o en uno de nuestros locales?';
const WEB_LOCAL_BUTTONS = [
  { id: 'web', title: 'Por la web' },
  { id: 'local', title: 'En un local' },
];
const ORDER_TOPIC_FOLLOWUP = {
  order_status: 'Dale, pasame el número de tu pedido (o el comprobante si fue en un local) para chequear el estado.',
  order_change: 'Perfecto, pasame el número de tu pedido (o el comprobante si fue en un local) para gestionar el cambio.',
};
```

- [ ] **Step 2: Add `handleMenuInteraction` (order branch only for now)**

Add this function right after `sendEntryMenu` (from Task 3):

```js
async function handleMenuInteraction({ from, channel, interactiveId, conversation }) {
  if (channel !== 'whatsapp') return false;

  if (interactiveId === 'menu_order_status' || interactiveId === 'menu_order_change') {
    const topic = interactiveId === 'menu_order_status' ? 'order_status' : 'order_change';
    await setMenuState(from, { pendingMenuTopic: topic });
    await appendMessage(from, { role: 'assistant', content: WEB_LOCAL_PROMPT });
    await sendWhatsAppInteractiveButtons(from, WEB_LOCAL_PROMPT, WEB_LOCAL_BUTTONS);
    return true;
  }

  if (interactiveId === 'web' || interactiveId === 'local') {
    const topic = conversation.pendingMenuTopic;
    const followup = ORDER_TOPIC_FOLLOWUP[topic] ?? ORDER_TOPIC_FOLLOWUP.order_status;
    await setMenuState(from, { pendingMenuTopic: null });
    await appendMessage(from, { role: 'assistant', content: followup });
    await sendWhatsAppMessage(from, followup);
    return true;
  }

  return false;
}
```

- [ ] **Step 3: Wire `type === 'interactive'` into `processIncomingMessageInternal`**

Right after the entry-menu block added in Task 3 Step 5 (and still before `// --- Non-text type handling ---`), add:

```js
  // --- Respuestas del menú guiado (botones/listas) ---
  if (type === 'interactive') {
    await appendMessage(from, { role: 'user', content: text || '(selección de menú)', contactName });
    const handled = await handleMenuInteraction({ from, channel, interactiveId: msg.interactiveId, conversation, departments, botConfig });
    if (!handled) {
      console.warn(`[bot] interactiveId no reconocido para ${from}: ${msg.interactiveId}`);
      const fallbackMsg = 'Perdón, no reconocí esa opción. ¿Podés contarme en tus propias palabras en qué te ayudo?';
      await appendMessage(from, { role: 'assistant', content: fallbackMsg });
      await sendWhatsAppMessage(from, fallbackMsg).catch(() => {});
    }
    return;
  }

```

Note: `processIncomingMessageInternal` destructures `msg` at its top (`const { channel, from, messageId, text, type, mediaId, mediaUrl, contactName } = msg;`) but not `interactiveId` — reference it as `msg.interactiveId` here rather than adding it to the destructure, since it's only used in this one place.

`departments` and `botConfig` are already in scope at this point in the function (loaded earlier via the `Promise.all` and `configDoc.data()`).

- [ ] **Step 4: Syntax-check**

```bash
cd server && node --check src/services/bot.service.js
```

- [ ] **Step 5: Manual verification**

With the dev server running and `flowMode: 'menu'` set (see Task 3 Step 8):

```bash
curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_order_branch","message":"hola"}' > /dev/null

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_order_branch","type":"interactive","interactiveId":"menu_order_status"}'
```

Expected: JSON response's last assistant message is `WEB_LOCAL_PROMPT` ("¿Fue una compra por la web o en uno de nuestros locales?").

```bash
curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_order_branch","type":"interactive","interactiveId":"web"}'
```

Expected: last assistant message is the `order_status` followup text ("Dale, pasame el número de tu pedido...").

```bash
curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_order_branch","message":"54729"}'
```

Expected: this is a **plain text** message (no `type`/`interactiveId`), so it flows through the unchanged existing pipeline — `reply` should be a Claude-generated answer referencing order `#54729` (same as it would today outside the menu flow, since `resolveOrderContext` doesn't know or care that a menu was involved).

- [ ] **Step 6: Clean up**

```bash
cd server && node --input-type=module -e "
import dotenv from 'dotenv'; dotenv.config();
import { initFirebase, getDb } from './src/services/firebase.service.js';
initFirebase();
await getDb().collection('bot-altorancho_conversations').doc('test_order_branch').delete();
console.log('limpio');
"
```

- [ ] **Step 7: Commit**

```bash
git add server/src/services/bot.service.js
git commit -m "$(cat <<'EOF'
Handle order status/change menu branches via web-or-local buttons

menu_order_status and menu_order_change now ask web-vs-local via a
2-button interactive message, then hand off to a plain-text prompt
for the order number — which flows into the existing, already-fixed
resolveOrderContext exactly as it would in the freeform flow.
EOF
)"
```

---

## Task 5: Stock branch

**Files:**
- Modify: `server/src/services/bot.service.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `handleMenuInteraction` now also handles `interactiveId === 'menu_stock'`.

- [ ] **Step 1: Add the stock prompt constant**

Add next to `ORDER_TOPIC_FOLLOWUP`:

```js
const STOCK_MENU_PROMPT = '¿Qué producto o SKU estás buscando?';
```

- [ ] **Step 2: Extend `handleMenuInteraction`**

In the `handleMenuInteraction` function from Task 4, add this branch after the `web`/`local` block and before `return false;`:

```js
  if (interactiveId === 'menu_stock') {
    await appendMessage(from, { role: 'assistant', content: STOCK_MENU_PROMPT });
    await sendWhatsAppMessage(from, STOCK_MENU_PROMPT);
    return true;
  }

```

(No `pendingMenuTopic` needed here — the next free-text reply flows straight into the unchanged `resolveStockContext`, which doesn't consult any menu state.)

- [ ] **Step 3: Syntax-check**

```bash
cd server && node --check src/services/bot.service.js
```

- [ ] **Step 4: Manual verification**

```bash
curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_stock_branch","message":"hola"}' > /dev/null

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_stock_branch","type":"interactive","interactiveId":"menu_stock"}'
```

Expected: last assistant message is `STOCK_MENU_PROMPT` ("¿Qué producto o SKU estás buscando?").

```bash
curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_stock_branch","message":"IME054CH"}'
```

Expected: plain text with a bare SKU — `reply` is a Claude answer built from real stock data (same as the freeform-flow fix from earlier this week; `resolveStockContext`'s `SKU_PATTERN` detects it directly).

- [ ] **Step 5: Clean up**

```bash
cd server && node --input-type=module -e "
import dotenv from 'dotenv'; dotenv.config();
import { initFirebase, getDb } from './src/services/firebase.service.js';
initFirebase();
await getDb().collection('bot-altorancho_conversations').doc('test_stock_branch').delete();
console.log('limpio');
"
```

- [ ] **Step 6: Commit**

```bash
git add server/src/services/bot.service.js
git commit -m "$(cat <<'EOF'
Handle stock menu branch

menu_stock asks what product/SKU the customer is after, then hands
off to the existing resolveStockContext on the next free-text reply.
EOF
)"
```

---

## Task 6: "Hablar con alguien" branch — department list + direct escalation

**Files:**
- Modify: `server/src/services/bot.service.js`

**Interfaces:**
- Consumes: `getActiveDepartments()` (already loaded as `departments` in `processIncomingMessageInternal`), `dispatchConversation`, `buildEscalationMessage` (both already exist in this file).
- Produces: `handleMenuInteraction` now also handles `interactiveId === 'menu_talk_to_agent'` and `interactiveId` starting with `'dept_'`.

- [ ] **Step 1: Add the department-menu constant and section builder**

Add next to `STOCK_MENU_PROMPT`:

```js
const TALK_TO_AGENT_PROMPT = '¿Con qué equipo querés hablar?';

function buildDepartmentSections(departments) {
  return [{
    title: 'Equipo Alto Rancho',
    rows: departments.map(d => ({ id: `dept_${d.id}`, title: d.name.slice(0, 24) })),
  }];
}
```

- [ ] **Step 2: Extend `handleMenuInteraction` — needs `departments` and `botConfig` now**

Update the function signature (it was already called with these two params since Task 4 Step 3, just not consuming them yet) and add the two new branches, right after the `menu_stock` block and before `return false;`:

```js
async function handleMenuInteraction({ from, channel, interactiveId, conversation, departments, botConfig }) {
  if (channel !== 'whatsapp') return false;

  if (interactiveId === 'menu_order_status' || interactiveId === 'menu_order_change') {
    const topic = interactiveId === 'menu_order_status' ? 'order_status' : 'order_change';
    await setMenuState(from, { pendingMenuTopic: topic });
    await appendMessage(from, { role: 'assistant', content: WEB_LOCAL_PROMPT });
    await sendWhatsAppInteractiveButtons(from, WEB_LOCAL_PROMPT, WEB_LOCAL_BUTTONS);
    return true;
  }

  if (interactiveId === 'web' || interactiveId === 'local') {
    const topic = conversation.pendingMenuTopic;
    const followup = ORDER_TOPIC_FOLLOWUP[topic] ?? ORDER_TOPIC_FOLLOWUP.order_status;
    await setMenuState(from, { pendingMenuTopic: null });
    await appendMessage(from, { role: 'assistant', content: followup });
    await sendWhatsAppMessage(from, followup);
    return true;
  }

  if (interactiveId === 'menu_stock') {
    await appendMessage(from, { role: 'assistant', content: STOCK_MENU_PROMPT });
    await sendWhatsAppMessage(from, STOCK_MENU_PROMPT);
    return true;
  }

  if (interactiveId === 'menu_talk_to_agent') {
    await appendMessage(from, { role: 'assistant', content: TALK_TO_AGENT_PROMPT });
    await sendWhatsAppInteractiveList(from, TALK_TO_AGENT_PROMPT, 'Ver equipos', buildDepartmentSections(departments));
    return true;
  }

  if (interactiveId?.startsWith('dept_')) {
    const deptId = interactiveId.slice('dept_'.length);
    const dept = departments.find(d => d.id === deptId);
    const deptName = dept?.name ?? 'Atención al cliente';
    await dispatchConversation(from, { status: 'escalated', humanMode: true, assignedTo: dept?.id ?? null });
    const escalationMsg = buildEscalationMessage(deptName, botConfig);
    await appendMessage(from, { role: 'assistant', content: escalationMsg });
    await sendWhatsAppMessage(from, escalationMsg);
    return true;
  }

  return false;
}
```

(This replaces the whole function body from Task 5 — it's the same branches plus these two new ones, shown in full since the function is small and this avoids ambiguity about insertion order.)

- [ ] **Step 3: Syntax-check**

```bash
cd server && node --check src/services/bot.service.js
```

- [ ] **Step 4: Manual verification**

```bash
curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_escalate_branch","message":"hola"}' > /dev/null

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_escalate_branch","type":"interactive","interactiveId":"menu_talk_to_agent"}'
```

Expected: last assistant message is `TALK_TO_AGENT_PROMPT`.

```bash
curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_escalate_branch","type":"interactive","interactiveId":"dept_facturacion"}'
```

Expected: last assistant message is the standard escalation confirmation ("Tu consulta fue derivada a *Facturación* 👋 ..."). Confirm in the response's `customer`/conversation state (or via `server/scripts/dump-chat.mjs test_escalate_branch` if still present from earlier in this project) that the conversation's `status` is `'escalated'` and `assignedTo` is `'facturacion'` — this can be checked directly in Firestore, or by re-adding a quick read:

```bash
cd server && node --input-type=module -e "
import dotenv from 'dotenv'; dotenv.config();
import { initFirebase, getDb } from './src/services/firebase.service.js';
initFirebase();
const doc = await getDb().collection('bot-altorancho_conversations').doc('test_escalate_branch').get();
console.log({ status: doc.data().status, assignedTo: doc.data().assignedTo, humanMode: doc.data().humanMode });
"
```

Expected: `{ status: 'escalated', assignedTo: 'facturacion', humanMode: true }`.

- [ ] **Step 5: Clean up**

```bash
cd server && node --input-type=module -e "
import dotenv from 'dotenv'; dotenv.config();
import { initFirebase, getDb } from './src/services/firebase.service.js';
initFirebase();
await getDb().collection('bot-altorancho_conversations').doc('test_escalate_branch').delete();
console.log('limpio');
"
```

- [ ] **Step 6: Commit**

```bash
git add server/src/services/bot.service.js
git commit -m "$(cat <<'EOF'
Handle "hablar con alguien" menu branch — direct escalation

menu_talk_to_agent shows the active departments as a list; picking
one dispatches the conversation straight to that department via the
existing dispatchConversation/buildEscalationMessage, with no Claude
call in this path.
EOF
)"
```

---

## Task 7: End-to-end regression pass

**Files:** none (verification only).

- [ ] **Step 1: Full menu walkthrough (all 4 branches) with `flowMode: 'menu'`**

```bash
curl -s -X PUT http://localhost:3000/api/config -H "Content-Type: application/json" -d '{"flowMode":"menu"}'
```

Repeat, for a fresh `contactId` each time, the sequences from Tasks 3-6:
1. `message: "hola"` → entry menu.
2. `interactiveId: "menu_order_status"` → web/local buttons → `interactiveId: "local"` → prompt → `message: "S08121"` → Claude reply about that order (or "no lo encuentro" if it genuinely doesn't exist — either is fine, the point is it reaches Claude with `orderInfo` correctly populated/absent, not that the specific test order exists).
3. `interactiveId: "menu_stock"` → prompt → `message: "stock de la silla tropez"` → Claude reply with stock info.
4. `interactiveId: "menu_talk_to_agent"` → department list → `interactiveId: "dept_atencion"` → escalation confirmation, no Claude call (verify via Firestore read as in Task 6 Step 4).

- [ ] **Step 2: Ignoring the menu falls back to freeform, never gets stuck**

```bash
curl -s -X PUT http://localhost:3000/api/config -H "Content-Type: application/json" -d '{"flowMode":"menu"}'

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_ignore_menu","message":"hola quiero saber el estado de mi pedido 54729"}' > /dev/null

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_ignore_menu","message":"si te escribo texto en vez de tocar el menu que pasa"}'
```

Expected: the second call gets a normal Claude `reply` (non-null) — the menu was shown once on the first message, was never tapped, and the second free-text message proceeded through the standard freeform pipeline without the bot demanding a menu selection.

- [ ] **Step 3: `flowMode: 'freeform'` (default) — full regression, nothing changed**

```bash
curl -s -X PUT http://localhost:3000/api/config -H "Content-Type: application/json" -d '{"flowMode":"freeform"}'

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_freeform_final","message":"hola"}'

curl -s -X POST http://localhost:3000/api/test/message -H "Content-Type: application/json" \
  -d '{"contactId":"test_freeform_final","message":"mi pedido es el 54729"}'
```

Expected: both calls behave exactly as they did before this plan — normal Claude greeting, then a normal order lookup — no interactive messages sent, no `menuShown`/`pendingMenuTopic` fields affecting anything (they exist on the doc as `false`/`null` but are never read when `flowMode !== 'menu'`).

- [ ] **Step 4: Clean up all test conversations created in this task**

```bash
cd server && node --input-type=module -e "
import dotenv from 'dotenv'; dotenv.config();
import { initFirebase, getDb } from './src/services/firebase.service.js';
initFirebase();
const ids = ['test_ignore_menu', 'test_freeform_final'];
for (const id of ids) await getDb().collection('bot-altorancho_conversations').doc(id).delete().catch(() => {});
console.log('limpio');
"
```

Also delete whichever `contactId`s you used for Step 1's 4-branch walkthrough.

- [ ] **Step 5: Reset the toggle to the safe default**

```bash
curl -s -X PUT http://localhost:3000/api/config -H "Content-Type: application/json" -d '{"flowMode":"freeform"}'
```

This is important — leave `flowMode` at `'freeform'` after testing so production WhatsApp traffic isn't affected until the client explicitly decides to turn the menu on.

- [ ] **Step 6: Final full-project syntax check**

```bash
cd server && node --check src/services/meta.service.js && node --check src/services/conversation.service.js && node --check src/services/bot.service.js && node --check src/routes/test.routes.js && echo "todo OK"
```

No commit for this task — it's verification-only. If any step reveals a bug, fix it in the relevant task's file, re-run that task's manual verification, and commit the fix with a message referencing which task it belongs to.
