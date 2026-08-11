# Filtro "Notificaciones" en Conversaciones

## Contexto

Los locales usan la página de Notificaciones para mandar plantillas masivas de WhatsApp (ej. "tu pedido está listo para retirar"). Cada envío crea o reutiliza la conversación del cliente y le agrega un mensaje `[Plantilla: nombre] ...`, pero la conversación queda mezclada con el resto en el filtro "Bot" — no hay forma de ver de un vistazo cuáles clientes fueron notificados y todavía no respondieron.

## Objetivo

Agregar un chip de filtro "Notificaciones" en la página de Conversaciones que muestre únicamente las conversaciones que recibieron una plantilla masiva y cuyo cliente todavía no respondió.

Fuera de alcance: recordatorios automáticos de seguimiento (día 3 / día 7). Esos hoy no dejan registro en la conversación (no llaman `appendMessage`), así que no van a alimentar este filtro. Si más adelante se quiere que también cuenten, es un cambio aparte.

## Diseño

### 1. Dato nuevo: `notifiedAt`

Campo `notifiedAt` (Firestore Timestamp) en el documento de conversación (`bot-altorancho_conversations`). Se setea a `new Date()` cada vez que `sendBulkOrders` (en `server/src/services/notifications.service.js`) le manda una plantilla a ese contacto — junto al `appendMessage` que ya existe ahí.

No se guardan datos adicionales (pedido, sucursal). El detalle de qué se mandó ya es visible como preview del último mensaje en la lista de conversaciones, porque el mensaje guardado es `[Plantilla: nombre] param1 | param2 | ...`.

### 2. Exponer el campo al frontend

En `mapConversationDoc` (`server/src/services/conversation.service.js`), agregar `notifiedAt: data.notifiedAt ?? null` al objeto devuelto, mismo patrón que el campo existente `lastClientMessageAt`. Esto lo expone automáticamente a través de `listConversations`, que ya trae las conversaciones que consume la página de Conversaciones (sin necesidad de un endpoint nuevo).

### 3. Filtro en el frontend

En `client/src/pages/Conversations.jsx`:

- Nueva entrada en `FILTERS`: `{ value: 'notifications', label: 'Notificaciones' }`.
- Nueva rama en el `.filter()` que arma `filtered` (~línea 764):
  - Excluir archivadas/resueltas (igual que los demás filtros).
  - Mostrar solo si `notifiedAt` existe.
  - Mostrar solo si el cliente no respondió después: `lastClientMessageAt` es nulo o su timestamp es anterior a `notifiedAt`.
- Se necesita un helper para comparar timestamps de Firestore (`{_seconds}` o string ISO) en el frontend — no existe hoy ahí, se agrega una función chica local (mismo criterio que `tsToMs` del backend).

En cuanto el cliente responde, `lastClientMessageAt` se actualiza solo (ya lo hace `appendMessage` en el flujo normal de mensajes entrantes) y la conversación sale del filtro sin lógica adicional de limpieza.

### 4. Búsqueda de notificaciones ya respondidas

No es parte de este filtro. Para encontrar una notificación vieja que ya fue contestada, se usa la búsqueda global existente (`/api/conversations/search`).

## Casos borde

- Un contacto notificado dos veces (dos pedidos distintos): `notifiedAt` se pisa con la fecha del envío más reciente. Si ya había respondido al primer envío y se le manda un segundo, vuelve a aparecer en el filtro hasta que responda de nuevo — comportamiento esperado.
- Límite de 200 conversaciones más recientes en `listConversations`: si pasan varios días sin respuesta y se acumulan muchas conversaciones nuevas, una notificación vieja sin respuesta podría salir de ese top 200 y dejar de verse en el filtro. Es una limitación preexistente de toda la pantalla (no específica de esta feature) — no se resuelve acá.
