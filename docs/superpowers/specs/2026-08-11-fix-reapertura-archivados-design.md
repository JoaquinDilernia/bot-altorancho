# Corrección: conversaciones archivadas que no se reabren al bot

## Contexto

Diseño esperado (confirmado con el usuario): "Archivados" es una carpeta estilo "resuelto" — se marca una conversación como terminada y se archiva, pero si el cliente vuelve a escribir, la conversación debe reabrirse automáticamente (siempre yendo al bot) y salir de Archivados.

Auditoría contra Firestore de producción encontró **43 conversaciones actualmente atascadas**: el cliente escribió después de que se archivaron, pero nunca volvieron a `status: 'bot'`. Se identificaron 2 causas raíz confirmadas con evidencia directa de datos reales:

1. **Cron de inactividad deja "zombies" (12 casos)**: `closeInactiveConversations` (`server/src/services/inactivity.service.js`) auto-resuelve conversaciones escaladas e inactivas >24hs llamando a `updateConversationStatus(contactId, 'resolved')` — esta función solo cambia `status`, nunca toca `humanMode`. La lógica de reapertura automática en `bot.service.js` (línea 368: `if (isArchived && !conversation.humanMode)`) exige `humanMode` apagado para reactivarse, así que estas conversaciones quedan bloqueadas para siempre: el cliente puede escribir indefinidamente y nunca se cumple la condición.

2. **Agentes responden directo sin reabrir formalmente (21 de 31 casos restantes)**: `POST /:contactId/reply` y `POST /:contactId/media` (`server/src/routes/conversation.routes.js`) nunca tocan `status` — un agente puede seguir la charla con normalidad desde el chat mientras la conversación queda invisible en Archivados todo el tiempo.

Un tercer grupo (9 casos) no tiene ninguna respuesta (ni de bot ni de agente) después del mensaje del cliente — no hay forma de confirmar la causa sin logs de producción de ese momento. Queda fuera de este arreglo, no se le inventa una solución sin evidencia.

## Diseño

### Fix 1 — El cron de inactividad limpia `humanMode` al auto-resolver

En `inactivity.service.js`, el bloque que cierra conversaciones escaladas por inactividad (líneas 70-81) cambia de usar `updateConversationStatus(contactId, 'resolved')` a `dispatchConversation(contactId, { status: 'resolved', humanMode: false })` — la misma función que ya usa el resto de la app para transicionar estados de forma completa (por ejemplo, el botón "Resuelto" en Conversaciones). Esto asegura que una conversación auto-cerrada por inactividad nunca quede con `humanMode: true` residual.

### Fix 2 — La reapertura automática se auto-repara, sin depender de `humanMode`

En `bot.service.js`, la condición de reapertura (línea 368) deja de exigir `!conversation.humanMode`:

```js
const isArchived = ['resolved', 'bot_archived'].includes(conversation.status)
  || conversation.status === 'urgent';
if (isArchived) {
  // ... fuerza status: 'bot', humanMode: false, assignedTo: null, igual que antes
}
```

Justificación: si el status es `resolved`/`bot_archived`, por definición del modelo de la app no debería haber nadie "manejando activamente" esa conversación — esa combinación (archivada + humanMode true) es en sí misma un estado inconsistente. Forzar `humanMode: false` en la reapertura, sin importar su valor previo, hace que el sistema se autorepare ante cualquier caso futuro de este problema (no solo los 12 ya confirmados), sin depender de que el Fix 1 cubra el 100% de las formas en que ese estado inconsistente podría producirse.

### Fix 3 — Un agente que responde a una conversación archivada la reabre

En `conversation.routes.js`, tanto `POST /:contactId/reply` como `POST /:contactId/media` chequean el status actual de la conversación (ya se lee el doc de Firestore en ambos handlers) antes de enviar: si está en `resolved`/`bot_archived`, se llama a `dispatchConversation(contactId, { status: 'escalated', humanMode: true, assignedTo: req.agent.email })` antes de mandar el mensaje — mismo patrón que ya usa `take_over`. Así, en cuanto un agente le escribe a un cliente archivado, la conversación pasa a "Mis casos"/"Escalado" de inmediato, en vez de seguir invisible en Archivados mientras la charla continúa.

## Fuera de alcance

- Los 9 casos sin ninguna respuesta posterior — no hay evidencia suficiente para diagnosticar la causa sin logs de producción del momento exacto. Si vuelve a pasar después de este arreglo, hay que revisarlo con logs en vivo.
- No se migra ninguna de las 43 conversaciones ya atascadas como parte de este cambio de código — el Fix 2 las corrige automáticamente en cuanto el cliente vuelva a escribir (que es el comportamiento esperado), así que no hace falta un script de migración aparte. Si el usuario quiere "desatascarlas" ya mismo sin esperar a que el cliente escriba, es una acción operativa aparte (correr un script una vez), no parte del fix de código.
