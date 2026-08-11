# Transcripción de audios en Conversaciones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un botón "Transcribir" en cada mensaje de audio del chat de Conversaciones que convierte ese audio a texto (español) usando la API Whisper de OpenAI, a pedido del agente.

**Architecture:** Pipeline nuevo del lado del servidor: `downloadMetaMedia` (meta.service.js) baja los bytes reales del audio desde Meta → `transcribeAudio` (transcription.service.js, nuevo) los manda a OpenAI Whisper → `setMessageTranscript` (conversation.service.js) persiste el texto en el mensaje dentro de Firestore, matcheando por `mediaId` (los audios entrantes no tienen `msgId`). Un endpoint nuevo (`POST /:contactId/media/:mediaId/transcribe`) orquesta las tres. El frontend agrega un botón a `MessageBubble` que llama a ese endpoint y muestra el resultado.

**Tech Stack:** Node.js (ESM) + Express, axios + `FormData`/`Blob` nativos de Node (mismo patrón que `uploadMetaMedia` en `meta.service.js`), OpenAI Whisper API (`whisper-1`). React + Vite. Sin framework de testing en este repo — verificación con `node -e` scripts, curl, build y navegador.

## Global Constraints

- No modificar el flujo del bot (`bot.service.js`) — el bot sigue sin poder "escuchar" audios, esto es solo para agentes humanos.
- La transcripción es a pedido (un botón por audio), nunca automática.
- Requiere `OPENAI_API_KEY` en `server/.env` — **el usuario todavía no la creó**. Los pasos que necesitan una llamada real a Whisper quedan marcados y se corren recién cuando esa key exista; el resto del pipeline (descarga de audio, endpoint, UI) se verifica sin depender de ella.
- Audio de prueba ya existente en Firestore (sin generar tráfico nuevo de WhatsApp): `contactId = "5493515742362"`, `mediaId = "1224546396470201"`.
- Spec de referencia: `docs/superpowers/specs/2026-08-11-transcripcion-audios-design.md`.

---

### Task 1: Backend — `downloadMetaMedia` en `meta.service.js`

**Files:**
- Modify: `server/src/services/meta.service.js` (refactor `getMetaMediaStream` para compartir el lookup de info; nueva función `downloadMetaMedia`)

**Interfaces:**
- Produces: `export async function downloadMetaMedia(mediaId)` → `Promise<{ buffer: Buffer, mimeType: string }>`. Consumido por Task 3 (endpoint).

- [ ] **Step 1: Leer el estado actual de `getMetaMediaStream`**

Confirmar que el archivo tiene esta forma antes de tocarlo (`server/src/services/meta.service.js`, función `getMetaMediaStream`):

```js
export async function getMetaMediaStream(mediaId, res) {
  if (!process.env.META_ACCESS_TOKEN) throw new Error('No META_ACCESS_TOKEN');
  const { data: info } = await axios.get(`${META_API_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
  });
  const response = await axios.get(info.url, {
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
    responseType: 'stream',
  });
  res.setHeader('Content-Type', info.mime_type || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  response.data.pipe(res);
}
```

- [ ] **Step 2: Refactorizar para compartir el lookup + agregar `downloadMetaMedia`**

Reemplazar ese bloque completo por:

```js
async function fetchMetaMediaInfo(mediaId) {
  const { data: info } = await axios.get(`${META_API_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
  });
  return info; // { url, mime_type, ... }
}

export async function getMetaMediaStream(mediaId, res) {
  if (!process.env.META_ACCESS_TOKEN) throw new Error('No META_ACCESS_TOKEN');
  const info = await fetchMetaMediaInfo(mediaId);
  const response = await axios.get(info.url, {
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
    responseType: 'stream',
  });
  res.setHeader('Content-Type', info.mime_type || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  response.data.pipe(res);
}

export async function downloadMetaMedia(mediaId) {
  if (!process.env.META_ACCESS_TOKEN) throw new Error('No META_ACCESS_TOKEN');
  const info = await fetchMetaMediaInfo(mediaId);
  const response = await axios.get(info.url, {
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
    responseType: 'arraybuffer',
  });
  return { buffer: Buffer.from(response.data), mimeType: info.mime_type || 'application/octet-stream' };
}
```

- [ ] **Step 3: Verificar `downloadMetaMedia` con el audio real de prueba**

Run desde `server/`: `node -e "
import('dotenv/config').then(async () => {
  const { downloadMetaMedia } = await import('./src/services/meta.service.js');
  const { buffer, mimeType } = await downloadMetaMedia('1224546396470201');
  console.log('mimeType:', mimeType);
  console.log('bytes descargados:', buffer.length);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"`

Expected: no tira error, `mimeType` empieza con `audio/`, `bytes descargados` es mayor a 0.

- [ ] **Step 4: Confirmar que el proxy de streaming existente sigue funcionando (no rompimos `getMetaMediaStream`)**

Run: `cd server && npm run dev` (en background), después con un token de agente válido:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "http://localhost:<PUERTO>/api/conversations/media/1224546396470201?token=<TOKEN>"
```

Expected: `200` y un `content_type` que empieza con `audio/`.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/meta.service.js
git commit -m "feat(media): agregar downloadMetaMedia para bajar audio/archivos en memoria"
```

---

### Task 2: Backend — `transcription.service.js`

**Files:**
- Create: `server/src/services/transcription.service.js`

**Interfaces:**
- Consumes: nada de otros archivos del proyecto (solo `axios`, `FormData`/`Blob` nativos, `process.env.OPENAI_API_KEY`).
- Produces: `export async function transcribeAudio(buffer, mimeType)` → `Promise<string>`. Consumido por Task 3 (endpoint).

- [ ] **Step 1: Crear el archivo**

```js
import axios from 'axios';

const EXT_BY_MIME = {
  ogg: 'ogg', mpeg: 'mp3', mp3: 'mp3', mp4: 'm4a', m4a: 'm4a', wav: 'wav', webm: 'webm',
};

function extForMime(mimeType) {
  const found = Object.keys(EXT_BY_MIME).find(key => mimeType?.includes(key));
  return found ? EXT_BY_MIME[found] : 'ogg';
}

export async function transcribeAudio(buffer, mimeType) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('language', 'es');
  form.append('file', new Blob([buffer], { type: mimeType }), `audio.${extForMime(mimeType)}`);
  const { data } = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  return data.text;
}
```

- [ ] **Step 2: Verificar el error explícito cuando falta la key**

Run desde `server/`: `node -e "
import('./src/services/transcription.service.js').then(async (m) => {
  delete process.env.OPENAI_API_KEY;
  try {
    await m.transcribeAudio(Buffer.from('x'), 'audio/ogg');
    console.error('ERROR: debería haber tirado excepción');
    process.exit(1);
  } catch (e) {
    console.log('Error esperado:', e.message);
  }
});
"`

Expected: imprime `Error esperado: OPENAI_API_KEY no configurada`, no tira ninguna otra excepción.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/transcription.service.js
git commit -m "feat(transcription): agregar transcribeAudio vía OpenAI Whisper"
```

- [ ] **Step 4: Verificación en vivo (recién cuando exista `OPENAI_API_KEY` en `server/.env`)**

**No ejecutar todavía si el usuario no agregó la key.** Cuando esté disponible, correr desde `server/`:

```bash
node -e "
import('dotenv/config').then(async () => {
  const { downloadMetaMedia } = await import('./src/services/meta.service.js');
  const { transcribeAudio } = await import('./src/services/transcription.service.js');
  const { buffer, mimeType } = await downloadMetaMedia('1224546396470201');
  const text = await transcribeAudio(buffer, mimeType);
  console.log('Transcripción:', text);
}).catch(e => { console.error('ERROR:', e.response?.data ?? e.message); process.exit(1); });
"
```

Expected: no tira error, imprime un texto en español coherente con el audio real de prueba.

---

### Task 3: Backend — `setMessageTranscript` + endpoint

**Files:**
- Modify: `server/src/services/conversation.service.js` (nueva función, después de `updateMessageStatus` línea ~218)
- Modify: `server/src/routes/conversation.routes.js` (imports + endpoint nuevo, después del bloque `POST /:contactId/media` línea ~417)

**Interfaces:**
- Consumes: `downloadMetaMedia` (Task 1), `transcribeAudio` (Task 2).
- Produces: `export async function setMessageTranscript(contactId, mediaId, transcript)` → `Promise<void>`. Endpoint `POST /api/conversations/:contactId/media/:mediaId/transcribe` → `{ transcript: string }`, consumido por Task 4 (frontend).

- [ ] **Step 1: Agregar `setMessageTranscript` en `conversation.service.js`**

Insertar inmediatamente después del cierre de `updateMessageStatus` (después de la línea 218, `}`):

```js
// Update a specific message's transcript by mediaId (audios entrantes no tienen msgId)
export async function setMessageTranscript(contactId, mediaId, transcript) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(contactId);
  const doc = await docRef.get();
  if (!doc.exists) return;
  const messages = doc.data().messages ?? [];
  const updated = messages.map(m => m.mediaId === mediaId ? { ...m, transcript } : m);
  await docRef.update({ messages: updated });
}
```

- [ ] **Step 2: Importar las nuevas funciones en `conversation.routes.js`**

Modificar los imports existentes (líneas 4-27):

Old:
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
import {
  sendWhatsAppMessage,
  sendInstagramMessage,
  sendWhatsAppTemplate,
  sendWhatsAppMedia,
  uploadMetaMedia,
  getMetaMediaStream,
} from '../services/meta.service.js';
```

New:
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
  setMessageTranscript,
} from '../services/conversation.service.js';
import {
  sendWhatsAppMessage,
  sendInstagramMessage,
  sendWhatsAppTemplate,
  sendWhatsAppMedia,
  uploadMetaMedia,
  getMetaMediaStream,
  downloadMetaMedia,
} from '../services/meta.service.js';
import { transcribeAudio } from '../services/transcription.service.js';
```

- [ ] **Step 3: Agregar el endpoint**

Insertar después del cierre del handler `router.post('/:contactId/media', ...)` (después de la línea 417, `});`):

```js
router.post('/:contactId/media/:mediaId/transcribe', async (req, res) => {
  try {
    const { contactId, mediaId } = req.params;
    const { buffer, mimeType } = await downloadMetaMedia(mediaId);
    const transcript = await transcribeAudio(buffer, mimeType);
    await setMessageTranscript(contactId, mediaId, transcript);
    res.json({ transcript });
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error('[transcribe] Error:', JSON.stringify(detail));
    res.status(502).json({ error: typeof detail === 'object' ? JSON.stringify(detail) : detail });
  }
});
```

- [ ] **Step 4: Verificar el endpoint con curl (sin `OPENAI_API_KEY` todavía — debe fallar de forma prolija, no explotar)**

Run: `cd server && npm run dev` (en background). Con un token de agente válido:

```bash
curl -s -X POST "http://localhost:<PUERTO>/api/conversations/5493515742362/media/1224546396470201/transcribe" -H "Authorization: Bearer <TOKEN>" | python3 -m json.tool
```

Expected (sin key todavía): `502` con `{"error": "OPENAI_API_KEY no configurada"}` — confirma que el pipeline completo (descarga real del audio incluida) corre sin errores hasta el punto esperado, sin tirar un 500 no controlado.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/conversation.service.js server/src/routes/conversation.routes.js
git commit -m "feat(conversations): agregar endpoint para transcribir un mensaje de audio"
```

- [ ] **Step 6: Verificación en vivo completa (recién cuando exista `OPENAI_API_KEY`)**

Repetir el curl del Step 4. Expected: `200` con `{"transcript": "..."}` con texto coherente. Confirmar además en Firestore (o releyendo `GET /:contactId/messages`) que el mensaje con ese `mediaId` ahora tiene el campo `transcript` guardado.

---

### Task 4: Frontend — botón "Transcribir" en `MessageBubble`

**Files:**
- Modify: `client/src/pages/Conversations.jsx` (`MessageBubble`, líneas ~159-201; punto de uso ~1055-1059)
- Modify: `client/src/pages/Conversations.module.css` (nuevas clases junto a `.msgAudio`, ~línea 1291)

**Interfaces:**
- Consumes: `POST /api/conversations/:contactId/media/:mediaId/transcribe` (Task 3) → `{ transcript }`. `authFetch`, `BASE_URL` ya importados a nivel de módulo en `Conversations.jsx` — no hace falta pasarlos como prop.

- [ ] **Step 1: Agregar el prop `contactId` y el estado de transcripción a `MessageBubble`**

Modificar la firma y el bloque de audio:

Old:
```jsx
function MessageBubble({ msg, onRetry }) {
  const isUser = msg.role === 'user';
  const isAdmin = msg.role === 'admin';
  const token = localStorage.getItem('altorancho_token');
  const mediaProxyUrl = msg.mediaId
    ? `${BASE_URL}/api/conversations/media/${msg.mediaId}?token=${encodeURIComponent(token ?? '')}`
    : null;
  const isError = isAdmin && msg.msgStatus === 'error';
  const [lightboxOpen, setLightboxOpen] = useState(false);
```

New:
```jsx
function MessageBubble({ msg, onRetry, contactId }) {
  const isUser = msg.role === 'user';
  const isAdmin = msg.role === 'admin';
  const token = localStorage.getItem('altorancho_token');
  const mediaProxyUrl = msg.mediaId
    ? `${BASE_URL}/api/conversations/media/${msg.mediaId}?token=${encodeURIComponent(token ?? '')}`
    : null;
  const isError = isAdmin && msg.msgStatus === 'error';
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [transcript, setTranscript] = useState(msg.transcript ?? null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState('');

  async function handleTranscribe() {
    setTranscribing(true);
    setTranscribeError('');
    try {
      const res = await authFetch(BASE_URL + `/api/conversations/${contactId}/media/${msg.mediaId}/transcribe`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al transcribir');
      setTranscript(data.transcript);
    } catch (err) {
      setTranscribeError(err.message);
    } finally {
      setTranscribing(false);
    }
  }
```

- [ ] **Step 2: Agregar el botón y el texto transcripto debajo del reproductor de audio**

Old:
```jsx
        {msg.mediaType === 'audio' && mediaProxyUrl && (
          <audio controls src={mediaProxyUrl} className={styles.msgAudio} />
        )}
```

New:
```jsx
        {msg.mediaType === 'audio' && mediaProxyUrl && (
          <div className={styles.msgAudioWrap}>
            <audio controls src={mediaProxyUrl} className={styles.msgAudio} />
            {transcript ? (
              <p className={styles.msgTranscript}>📝 {transcript}</p>
            ) : (
              <button type="button" className={styles.transcribeBtn} onClick={handleTranscribe} disabled={transcribing}>
                {transcribing ? 'Transcribiendo...' : '📝 Transcribir'}
              </button>
            )}
            {transcribeError && <p className={styles.msgTranscribeError}>{transcribeError}</p>}
          </div>
        )}
```

- [ ] **Step 3: Pasar `contactId` en el punto de uso**

Old:
```jsx
                  return (
                    <MessageBubble
                      key={i}
                      msg={msg}
                      onRetry={canRetry ? handleRetry : null}
                    />
                  );
```

New:
```jsx
                  return (
                    <MessageBubble
                      key={i}
                      msg={msg}
                      onRetry={canRetry ? handleRetry : null}
                      contactId={selected.id}
                    />
                  );
```

- [ ] **Step 4: Agregar las clases CSS nuevas**

En `client/src/pages/Conversations.module.css`, insertar después del bloque `.msgAudio` (después de la línea 1291, `}`):

```css
.msgAudioWrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.msgTranscript {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-alt);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  max-width: 260px;
  font-size: var(--font-size-sm);
  color: var(--color-text);
}

.transcribeBtn {
  align-self: flex-start;
  padding: 3px 10px;
  background: #fff;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-size: 11px;
  cursor: pointer;
}

.transcribeBtn:hover:not(:disabled) {
  background: var(--color-surface-alt);
}

.transcribeBtn:disabled {
  opacity: 0.6;
  cursor: default;
}

.msgTranscribeError {
  margin: 0;
  font-size: 11px;
  color: #dc2626;
}
```

- [ ] **Step 5: Build para verificar sintaxis**

Run: `cd client && npm run build`
Expected: build exitoso, sin errores.

- [ ] **Step 6: Prueba manual en el navegador (con la key ya puesta)**

Abrir la conversación de prueba (`5493515742362`) en Conversaciones, buscar el mensaje de audio con `mediaId` `1224546396470201`, tocar "📝 Transcribir" y confirmar que aparece el texto debajo del reproductor sin errores en consola. Recargar la página y confirmar que el texto sigue apareciendo (persiste en Firestore vía `msg.transcript`, no se pierde).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Conversations.jsx client/src/pages/Conversations.module.css
git commit -m "feat(conversations): agregar botón para transcribir mensajes de audio"
```
