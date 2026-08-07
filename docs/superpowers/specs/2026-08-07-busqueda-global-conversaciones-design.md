# Búsqueda global de conversaciones — Design Spec

**Fecha:** 2026-08-07
**Estado:** Aprobado, pendiente de implementación

## Contexto

El buscador actual del panel de conversaciones (`client/src/pages/Conversations.jsx`) tiene tres problemas:

1. **Es 100% client-side y opera sobre un subconjunto ya filtrado.** El frontend carga los 200 chats más recientes vía `GET /api/conversations` (Firestore `orderBy('updatedAt').limit(200)`), y el `search` se aplica en el mismo `.filter()` que ya aplicó la pestaña activa (bot/mios/urgentes/etc.) y el filtro de labels. Como resultado, buscar solo encuentra coincidencias dentro de la pestaña en la que estás parado, y nunca encuentra nada fuera de los 200 chats más recientemente actualizados.
2. **El backend ya restringe por rol.** Para agentes con rol `operador`, `GET /api/conversations` filtra por `assignedTo` (departamento o email del agente) antes de que el frontend reciba los datos — una segunda capa de restricción que el buscador nunca puede superar.
3. **La coincidencia de texto es pobre.** Solo compara contra `contactName`/`contactId`. No busca dentro de los mensajes del chat ni por número de pedido asociado al cliente.

No existe hoy ningún campo de número de pedido guardado en la conversación — el pedido de TiendaNube se resuelve en vivo (`tiendanube.service.js`, `bot.service.js` → `searchOrderByRef`) y se cachea por cliente (`bot-altorancho_customers/{contactId}.tnOrders`) solo cuando se abre ese chat puntual. Los mensajes se guardan como array dentro del documento de conversación (no en subcolección), y solo se cargan al abrir un chat.

## Objetivo

Reemplazar el filtro local por una búsqueda real de backend que:

- Busque en **toda la base de conversaciones**, sin restricción de departamento/rol ni de pestaña activa, incluyendo archivadas/cerradas.
- Encuentre coincidencias por nombre de contacto, teléfono, **texto dentro de los mensajes**, y **número de pedido asociado al cliente** (aunque ese número nunca se haya escrito en el chat).

## Alcance y permisos

- El nuevo endpoint de búsqueda **no** aplica el filtro `assignedTo` que hoy restringe a los agentes con rol `operador` a su departamento/email. Cualquier agente que use el buscador puede encontrar conversaciones de cualquier departamento, canal (WhatsApp/Instagram) y estado (activa, archivada, cerrada).
- Este cambio de permisos aplica **únicamente al endpoint de búsqueda**. El listado normal por pestañas (`GET /api/conversations`, usado cuando el campo de búsqueda está vacío) no cambia — sigue restringido y limitado a 200 resultados como hoy.

## Diseño

### Backend — nuevo endpoint

`GET /api/conversations/search?q=<texto>`

Nueva función `searchConversations(query)` en `server/src/services/conversation.service.js`:

1. Trae **todas** las conversaciones de Firestore (sin `limit(200)`, sin filtro `assignedTo`, sin filtro de `status`).
2. Para cada conversación, evalúa coincidencia case-insensitive contra:
   - `contactName`
   - `contactId` / teléfono
   - el texto de cada mensaje dentro del array `messages`
3. En paralelo, detecta si `query` tiene forma de número de pedido, reutilizando el mismo patrón de reconocimiento que ya usa `searchOrderByRef` en `bot.service.js` (número puro, `#123`, `S123` → Odoo, `TN123` → Odoo). Si matchea:
   - Dispara la misma búsqueda en vivo contra TiendaNube/Odoo que usa el bot para resolver pedidos (`tiendanube.service.js` / `odoo.service.js`).
   - Si el pedido existe, obtiene teléfono/email del cliente asociado y busca conversaciones cuyo `contactId` (o campo de teléfono/email equivalente) matchee ese contacto.
4. Combina y deduplica los resultados de ambos caminos (texto + pedido) por `contactId`.
5. Devuelve como máximo 100 resultados, ordenados por `updatedAt` descendente.

Ruta nueva en `server/src/routes/conversation.routes.js`, sin aplicar el filtro `assignedToFilter` que sí usa la ruta `GET /`.

### Frontend (`client/src/pages/Conversations.jsx`)

- Cuando el campo de búsqueda tiene contenido (mínimo 2 caracteres), con debounce de ~350ms, se llama a `GET /api/conversations/search?q=...` y los resultados reemplazan la lista renderizada (en vez de filtrar el array `conversations` local).
- Mientras el campo de búsqueda está vacío, el comportamiento actual (pestañas, labels, límite de 200) no se modifica.
- Se muestra un indicador de carga mientras la request de búsqueda está en curso.
- Se limpia/cancela la búsqueda en curso si el usuario sigue tipeando (debounce estándar, descartar responses obsoletas).

## Límites conocidos (aceptados para esta iteración)

Se optó por un escaneo simple en memoria del lado del backend (sin índice de tokens ni motor de búsqueda dedicado) porque no se conoce el volumen exacto de conversaciones y se prioriza velocidad de implementación. Esto implica:

- Cada búsqueda lee y recorre **todas** las conversaciones de Firestore — el costo (lecturas de Firestore) y la latencia crecen linealmente con el tamaño de la colección.
- Si en el futuro el volumen de conversaciones crece a decenas de miles o más y esto se vuelve lento/costoso, las mejoras evaluadas y descartadas por ahora son:
  - Mantener un campo `searchTokens` (array de palabras indexadas) actualizado en cada escritura de mensaje/conversación, y consultar con `array-contains-any` — evita el escaneo completo pero requiere migrar conversaciones existentes y tocar el código de escritura de mensajes.
  - Delegar a un motor de búsqueda dedicado (Meilisearch autohospedado o Algolia) con un pipeline de sincronización desde Firestore — mejor calidad de búsqueda (tolerancia a errores de tipeo, ranking) pero requiere infraestructura y mantenimiento adicional.
- La búsqueda de pedido en vivo agrega latencia de red hacia TiendaNube/Odoo cuando el texto ingresado matchea el patrón de número de pedido — aceptado a cambio de encontrar pedidos que nunca se escribieron literalmente en el chat.

## Fuera de alcance

- No se agregan campos de número de pedido persistidos en el documento de conversación (se resuelve en vivo, ver arriba).
- No se cambia el comportamiento del listado normal por pestañas (`GET /api/conversations`) ni el límite de 200 ni el filtro `assignedTo` para ese endpoint.
- No se agrega highlighting de coincidencias en el mensaje encontrado ni indicador de "por qué matcheó" en el resultado (podría agregarse en una iteración futura de UX, no requerido ahora).

## Testing

- Backend: test de `searchConversations` cubriendo match por nombre, por teléfono, por texto de mensaje, y por número de pedido (con Odoo/TiendaNube mockeados).
- Verificar manualmente que un agente `operador` de un departamento encuentra, vía búsqueda, una conversación asignada a otro departamento.
- Verificar que buscar un número de pedido que nunca fue escrito en el chat encuentra la conversación del cliente correspondiente.
- Verificar que conversaciones archivadas aparecen en resultados de búsqueda.
