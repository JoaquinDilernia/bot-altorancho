# Preview de mensaje citado (reply de WhatsApp)

## Contexto

Cuando un cliente responde citando (swipe-reply) un mensaje anterior en WhatsApp —
sea un mensaje del bot/agente o un mensaje suyo propio — el sistema hoy lo trata
como un mensaje suelto más. Se pierde por completo la referencia a qué está
respondiendo el cliente. Esto es especialmente problemático cuando la conversación
ya está en manos de un agente humano (ej. Atención al Cliente): el agente ve el
mensaje citado sin ningún contexto de a qué pregunta o comentario anterior
corresponde.

WhatsApp manda esta información nativamente en el campo `context.id` de cada
mensaje entrante que es una respuesta citada, pero el webhook actual (`meta.service.js`)
lo ignora por completo.

## Diseño

### 1. Parsear el campo `context` de WhatsApp

En `server/src/services/meta.service.js`, función `parseWhatsAppMessage` (~línea 301),
leer `msg.context?.id` y agregarlo al objeto devuelto como `replyToWaMsgId` (`null` si
no hay cita). Aplica a los tres `return` de la función (interactive, media, texto).

Instagram queda **fuera de alcance** — su estructura de reply es distinta y no forma
parte de este cambio.

### 2. Guardar el id de WhatsApp también en mensajes entrantes

En `server/src/services/conversation.service.js`, función `appendMessage` (~línea 48),
hoy los mensajes con `role: 'user'` no guardan ningún id de WhatsApp — solo los
salientes (`assistant`/`admin`) lo reciben más tarde vía `updateMessageStatus`.

Esto rompe específicamente el caso de "el cliente cita un mensaje suyo anterior":
no hay nada contra qué matchear esa cita. Se resuelve guardando `waMsgId: message.messageId`
también para mensajes entrantes, cuando ese campo venga presente en el `message`
que se le pasa a `appendMessage`.

`parseWhatsAppMessage` ya devuelve `messageId: msg.id` para los tres tipos de
retorno (viene de antes de este cambio). Lo que falta es que `bot.service.js`
lo propague: los ~8 call-sites de `appendMessage({ role: 'user', ... })` en
`server/src/services/bot.service.js` (bloque ~línea 397-493: texto, media, interactive,
audio, documento, imagen) deben agregar `messageId: msg.messageId` al objeto que
arman, para que `appendMessage` tenga ese dato disponible y lo guarde como `waMsgId`.

### 3. Resolver el preview al momento de guardar el mensaje (snapshot)

En los mismos puntos del punto 2 (bloque ~línea 397-493 de `bot.service.js`), si
el mensaje parseado trae `replyToWaMsgId`:

1. Buscar en el `messages` array de la conversación (ya cargado como `history`/`conversation`
   en ese punto del flujo) el mensaje cuyo `waMsgId === replyToWaMsgId`.
2. Si se encuentra: armar `replyTo: { preview, role }` donde `preview` es el
   `content` de ese mensaje truncado a 80 caracteres (+ `…` si se corta), y `role`
   es su `role` (`user`/`assistant`/`admin`) — se usa para el label "Cliente"/"Alto"/"Agente"
   en el frontend, igual que ya hace `MessageBubble`.
3. Si no se encuentra (mensaje fuera de la ventana de 200 guardados, o de antes de
   este cambio): no se agrega `replyTo`. El mensaje se guarda y procesa normal,
   sin romper nada.

Se guarda el **snapshot** del texto (no una referencia viva) — mismo criterio que
usa WhatsApp nativamente. Sobrevive aunque el mensaje original se recorte del
historial (`.slice(-200)` en `appendMessage`) más adelante, y evita que el frontend
tenga que resolver la cita con un lookup aparte.

### 4. Mostrar el preview en el frontend

En `client/src/pages/Conversations.jsx`, componente `MessageBubble` (~línea 159),
si `msg.replyTo` existe, renderizar un recuadro citado **arriba** de `msg.content`:
borde izquierdo de color, texto del preview en gris/muted, atribuido según
`msg.replyTo.role` con el mismo mapeo que ya usa el bloque de meta
(`isUser ? 'Cliente' : isAdmin ? 'Agente' : 'Alto'`, línea ~252). Solo texto,
no clickeable, mismo estilo visual del reply-preview nativo de WhatsApp.

## Fuera de alcance

- Instagram (estructura de reply distinta, no se usa tanto por el cliente).
- Click en el recuadro citado para hacer scroll hasta el mensaje original.
- Backfill de `replyTo` en mensajes ya guardados antes de este cambio.
