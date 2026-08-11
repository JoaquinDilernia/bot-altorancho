# Transcripción de audios en Conversaciones

## Contexto

Hoy, cuando un cliente manda un audio de WhatsApp, el bot responde "no puedo escucharlo" y (si insiste) deriva a un agente. El agente humano solo puede reproducir el audio crudo — no hay forma de leer lo que dice sin escucharlo entero. Se pide poder transcribir esos audios a texto.

## Objetivo

Agregar un botón "Transcribir" en cada mensaje de audio del chat que, al tocarlo, convierte ese audio puntual a texto y lo muestra debajo del reproductor.

## Alcance

- Solo afecta a la vista del agente humano — **no** se toca el flujo del bot (`bot.service.js` sigue respondiendo "no puedo escuchar audios" como hoy).
- Transcripción a pedido (botón por audio), no automática — controla el costo.
- Transcripción, no traducción de idioma — los clientes hablan español, el objetivo es convertir voz a texto en el mismo idioma.
- Aplica a cualquier mensaje de audio (entrante del cliente o saliente del agente/bot), sin restricción por rol.

## Proveedor

OpenAI Whisper API (`whisper-1`, endpoint `/v1/audio/transcriptions`), con idioma forzado a `es`. Requiere una nueva variable de entorno `OPENAI_API_KEY` — la crea y factura el usuario, no existe hoy en el proyecto (que solo tiene `ANTHROPIC_API_KEY`).

## Diseño

### Backend

1. **`server/src/services/meta.service.js`** — nueva función `downloadMetaMedia(mediaId)` que devuelve `{ buffer, mimeType }` con el contenido real del archivo (dos pasos: pedir la URL firmada a Meta, después bajar el binario). Reutiliza el mismo lookup de info que ya hace `getMetaMediaStream`, pero en vez de hacer streaming a una respuesta HTTP, devuelve los bytes en memoria para poder reenviarlos a OpenAI.

2. **`server/src/services/transcription.service.js`** (nuevo archivo) — `transcribeAudio(buffer, mimeType)`:
   - Arma un `FormData` nativo (`new FormData()` + `new Blob([buffer], { type: mimeType })`, mismo patrón que ya usa `uploadMetaMedia` en `meta.service.js` para subir audio a Meta).
   - Elige una extensión de archivo según el `mimeType` (WhatsApp manda `audio/ogg; codecs=opus` casi siempre; se contempla también mp3/m4a/wav/webm como fallback, y `ogg` como default).
   - `POST https://api.openai.com/v1/audio/transcriptions` con `model: whisper-1`, `language: es`, header `Authorization: Bearer ${OPENAI_API_KEY}`.
   - Devuelve el campo `text` de la respuesta.
   - Si `OPENAI_API_KEY` no está configurada, tira un error explícito ("OPENAI_API_KEY no configurada") antes de llamar a la API.

3. **`server/src/services/conversation.service.js`** — nueva función `setMessageTranscript(contactId, mediaId, transcript)`: busca dentro del array `messages` del documento el mensaje con ese `mediaId` (no `msgId` — los audios entrantes del cliente no tienen `msgId`, ese campo solo lo generan los mensajes salientes) y le agrega el campo `transcript`. Mismo patrón que la función existente `updateMessageStatus` (que hace lo mismo pero matcheando por `msgId` para actualizar `msgStatus`).

4. **`server/src/routes/conversation.routes.js`** — nuevo endpoint `POST /:contactId/media/:mediaId/transcribe`:
   - Descarga el audio con `downloadMetaMedia(mediaId)`.
   - Lo transcribe con `transcribeAudio(buffer, mimeType)`.
   - Guarda el resultado con `setMessageTranscript(contactId, mediaId, transcript)`.
   - Responde `{ transcript }`.
   - Si algo falla (falta la API key, el audio no existe en Meta, OpenAI devuelve error), responde `502` con un mensaje legible — mismo criterio que el resto de los endpoints que llaman a APIs externas en este archivo.

### Frontend

En `client/src/pages/Conversations.jsx`, componente `MessageBubble` (recibe un nuevo prop `contactId`):

- Debajo del reproductor `<audio>` (cuando `msg.mediaType === 'audio'`), un botón "📝 Transcribir".
- Al tocarlo: `POST /api/conversations/:contactId/media/:mediaId/transcribe`, con estado de carga ("Transcribiendo...") y de error visible si falla.
- Al completarse, el texto se guarda en estado local del componente y se muestra debajo del audio — no hace falta volver a pedirlo mientras la burbuja siga montada. Si `msg.transcript` ya viene con valor (porque otro agente ya lo transcribió antes y el polling trajo el mensaje actualizado), se muestra directo sin botón.

## Costo

Whisper cobra por duración de audio (~$0.006 USD/minuto). Al ser a pedido, el costo lo determina cuántos audios los agentes deciden transcribir, no el volumen total de audios recibidos.

## Fuera de alcance

- Bot procesando audios automáticamente (fuera de alcance, ver "Alcance" arriba).
- Transcripción automática al recibir el audio.
- Traducción real de idioma (solo transcripción en español).
- Reintentos automáticos o caché de resultados más allá de lo que ya persiste `transcript` en el mensaje.
