# Flujo guiado por menú (WhatsApp interactivo) — Diseño

## Contexto y objetivo

Hoy, BOT-ALTORANCHO responde siempre en texto libre: el primer mensaje del cliente entra directo a Claude, que interpreta la intención (pedido, stock, cambio, etc.) mediante extracción de patrones sobre el texto. Esto funciona pero depende de que el cliente escriba de forma reconocible, y varios de los bugs encontrados en la ronda de testing del 2026-07-17/20 (número de pedido no detectado si no está pegado a la palabra clave, SKU suelto sin disparar el chequeo de stock, la IA inventando un pedido cuando no encontraba nada) vienen justamente de la ambigüedad de interpretar texto libre.

El jefe del cliente pidió explorar, **en paralelo** y sin tocar el flujo actual, un flujo guiado por menú (botones/listas nativas de WhatsApp) que arranque la conversación preguntando por categoría, junta la info relevante paso a paso, y con eso responde (vía Claude) o deriva a un humano.

**No objetivo:** reemplazar el flujo actual. El flujo de texto libre con Claude sigue siendo el comportamiento por defecto y no se modifica su lógica central (más allá de las mejoras ya aplicadas esta semana: cola por contacto, extracción de pedido reforzada, SKU directo, anti-alucinación).

## Alcance

Incluye:
- Toggle global `bot_config.flowMode` (`'freeform'` default | `'menu'`).
- Mensaje de menú (lista interactiva) al primer mensaje de una conversación nueva/reabierta, con 4 opciones: Estado de pedido, Cambios y devoluciones, Stock y productos, Hablar con alguien del equipo.
- Soporte nuevo en `meta.service.js` para mandar y recibir mensajes interactivos de WhatsApp (no existe hoy).
- Manejo de las 4 ramas, reutilizando la lógica de negocio ya existente (`resolveOrderContext`, `resolveStockContext`, `dispatchConversation`, `getActiveDepartments`).
- Fallback a texto libre si el cliente ignora el menú.

No incluye (fuera de alcance para esta iteración):
- Menú de Instagram (Instagram no soporta mensajes interactivos de lista/botón de la misma forma; esta iteración es solo WhatsApp).
- Menús posteriores a la primera respuesta ("¿algo más?" con botones de nuevo) — decidido explícitamente que no, en esta iteración.
- Templates de respuesta sin IA — decidido explícitamente que no: la redacción final siempre pasa por Claude, el menú solo mejora la calidad del contexto que recibe.
- Cambios al comportamiento cuando `flowMode === 'freeform'` (default): cero impacto en producción hasta que se active el toggle.

## Arquitectura y flujo de datos

```
Webhook WhatsApp → parseWhatsAppMessage
                        │
                        ├─ type: 'interactive' → { interactiveId, text: título }
                        └─ type: 'text'/media  → como hoy
                        │
                  processIncomingMessage (bot.service.js)
                        │
          flowMode === 'menu' Y conversación nueva/reabierta Y !menuShown?
                        │
              ┌─────────┴─────────┐
             sí                   no / ya resuelto
              │                    │
    sendWhatsAppInteractiveList    flujo actual sin cambios
    (4 opciones), marca
    menuShown=true, corta acá
    (no llama a Claude todavía)
              │
    [el cliente responde]
              │
    ¿type === 'interactive'?
              │
      ┌───────┴────────┐
     sí                no (texto libre)
      │                 │
  branch por      ¿hay pendingMenuTopic?
  interactiveId      │           │
  (ver sección       sí          no
  "Las 4 ramas")      │           │
                 es la respuesta   se abandona el menú
                 al dato pedido    para esta conversación,
                 (número/SKU) →    sigue freeform normal
                 sigue flujo        (Claude interpreta
                 normal con         el texto tal cual)
                 orderInfo/
                 stockInfo
```

## Componentes nuevos

### `meta.service.js`

- **`sendWhatsAppInteractiveList(to, bodyText, buttonText, sections)`** — envía un mensaje `type: 'interactive'`, `interactive.type: 'list'`. `sections` es un array de `{ title, rows: [{ id, title, description? }] }` (máximo 10 filas en total, límite de la API de WhatsApp). Sigue el mismo patrón de `sendWhatsAppMessage` (retorna el ID del mensaje o `null` si no hay tokens configurados, usa `postWithSafeRetry`).
- **`sendWhatsAppInteractiveButtons(to, bodyText, buttons)`** — envía `interactive.type: 'button'`, hasta 3 botones (`{ id, title }`). Se usa para la pregunta binaria "web o local".
- **`parseWhatsAppMessage`** — se extiende el `switch`/mapeo de tipos: cuando `msg.type === 'interactive'`, extraer `msg.interactive.list_reply ?? msg.interactive.button_reply` y devolver:
  ```js
  {
    ...campos existentes,
    type: 'interactive',
    interactiveId: reply.id,       // ej: "menu_order_status"
    text: reply.title,             // para que el resto del pipeline (historial, logs) tenga un texto legible
  }
  ```

### `bot.service.js`

- **`getMenuSections(departments)`** — arma las `sections` de la lista de entrada (las 4 opciones fijas) y, por separado, las del sub-menú de "Hablar con alguien" (una fila por cada `department` activo, vía `getActiveDepartments()` que ya se usa en el flujo de escalación actual).
- **Punto de intercepción en `processIncomingMessageInternal`**, antes de la carga de contexto pesado (justo después de resolver `conversation`/`botConfig`):
  - Si `botConfig.flowMode === 'menu'` Y es un mensaje nuevo de una conversación sin `menuShown` (reutiliza la misma detección de "nueva o reabierta" que ya existe para el auto-reopen de archivadas) → manda la lista de 4 opciones, guarda `menuShown: true` en el doc, hace `appendMessage` del mensaje de menú como si fuera un mensaje de `assistant` (para que quede en el historial), y **retorna** sin llamar a Claude.
  - Si el mensaje entrante es `type === 'interactive'` → resolver por `interactiveId`:
    - `menu_order_status` / `menu_order_change` → responde con `sendWhatsAppInteractiveButtons` preguntando web/local, guarda un estado transitorio mínimo (`pendingMenuTopic: 'order_status' | 'order_change'`) en el doc, corta ahí.
    - `menu_stock` → manda un mensaje de texto simple "¿qué producto o SKU buscás?", guarda `pendingMenuTopic: 'stock'`, corta ahí.
    - `menu_talk_to_agent` → manda la lista de departamentos (segundo nivel), corta ahí.
    - `web`/`local` (respuesta al sub-botón) o un `department_id` (respuesta al sub-menú de departamentos) → se consulta `pendingMenuTopic` guardado para saber a qué rama pertenece esta respuesta (`order_status` u `order_change`) y se resuelve en consecuencia (ver abajo).
  - Si el mensaje entrante es texto libre y hay un `pendingMenuTopic` pendiente → ese texto es la respuesta a la pregunta abierta (número de pedido, SKU, etc.); se limpia `pendingMenuTopic` y se arma `orderInfo`/`stockInfo` con las funciones existentes (`resolveOrderContext`/`resolveStockContext`, sin cambios) usando ese texto, y se llama a `generateBotResponse` normalmente — mismo camino que el flujo freeform de hoy a partir de acá.
  - Si el mensaje entrante es texto libre y **no** hay `pendingMenuTopic` (el cliente ignoró el menú desde el arranque) → se abandona el menú para esta conversación (no se vuelve a intentar) y sigue el flujo freeform normal sin ninguna diferencia respecto a hoy.

### Datos nuevos en el doc de `bot-altorancho_conversations`

- `menuShown: boolean` — si ya se mostró el menú de entrada en esta sesión de conversación. Se resetea a `false` cuando la conversación se reabre desde archivada (mismo punto donde hoy ya se resetean `status`/`humanMode`).
- `pendingMenuTopic: string | null` — tema elegido en el menú que está esperando un dato de texto libre (`'order_status' | 'order_change' | 'stock' | null`). Se limpia apenas se usa.

## Las 4 ramas

1. **Estado de pedido** → botón web/local → texto libre (número/comprobante) → `resolveOrderContext(texto, ...)` (sin cambios, ya soporta número con o sin `#`, pegado o no a palabras clave) → `generateBotResponse` con `orderInfo` armado.
2. **Cambios y devoluciones** → mismo camino que (1); la diferencia de tema queda reflejada en el historial (el cliente vio el botón "Cambios y devoluciones") y Claude ya sabe interpretar eso con el knowledge base existente.
3. **Stock y productos** → texto libre directo (producto o SKU) → `resolveStockContext(texto)` (ya detecta SKU suelto) → `generateBotResponse` con `stockInfo` armado.
4. **Hablar con alguien del equipo** → sub-menú de departamentos → al elegir uno, `dispatchConversation(from, { status: 'escalated', humanMode: true, assignedTo: deptId })` directo + mensaje de confirmación (`buildEscalationMessage`, ya existe) — esta rama no llama a Claude.

## Manejo de errores / fallback

- Si `sendWhatsAppInteractiveList`/`Buttons` falla (tokens no configurados, error de Meta) → se loguea y se cae al flujo freeform normal para ese mensaje (no se bloquea la conversación esperando un menú que nunca llegó).
- Si el cliente responde con texto libre en cualquier punto del flujo guiado (ya sea al arranque o mientras hay un `pendingMenuTopic`) → se toma ese texto tal cual y se lo pasa a la lógica existente (`resolveOrderContext`/`resolveStockContext` ya extraen del texto libre igual, con o sin el contexto del menú) — nunca se le pide "elegí una opción" de nuevo, nunca queda trabado.
- Si `flowMode` no está seteado en `bot_config` → default `'freeform'`, cero cambio de comportamiento.

## Testing

- Simulación de los 4 caminos completos vía `test.routes.js` (ya existe, no toca WhatsApp real), incluyendo el payload `interactive` con `list_reply`/`button_reply` simulado.
- Caso "ignora el menú": mandar texto libre como primer mensaje con `flowMode: 'menu'` activo y confirmar que responde igual que en `freeform`.
- Caso `flowMode: 'freeform'` (default): confirmar que ningún mensaje interactivo se envía y el comportamiento es idéntico al actual.
- Prueba manual en el número de test real de WhatsApp antes de considerar activarlo para el número de producción.

## Cambios pendientes de decisión (ninguno)

Todas las decisiones de diseño quedaron cerradas en la conversación de brainstorming del 2026-07-21. La siguiente etapa es el plan de implementación (`writing-plans`).
