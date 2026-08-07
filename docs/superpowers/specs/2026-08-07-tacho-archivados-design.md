# Tacho de archivados sin restricción — Design Spec

**Fecha:** 2026-08-07
**Estado:** Aprobado, pendiente de implementación

## Contexto

La pestaña "Archivos" del panel de conversaciones (`client/src/pages/Conversations.jsx`) hoy no es un tacho real: reutiliza la misma lista que usan todas las demás pestañas (`GET /api/conversations`), que tiene dos restricciones que no tienen sentido para un archivo histórico:

1. **Límite de 200 conversaciones más recientes** (`server/src/services/conversation.service.js`, `listConversations` → `orderBy('updatedAt', 'desc').limit(200)`). Como archivar/resolver una conversación detiene sus actualizaciones, con el tiempo cualquier conversación archivada queda fuera de esas 200 más recientes (desplazada por conversaciones activas) y desaparece de la pestaña "Archivos" aunque siga archivada.
2. **Restricción por departamento del agente.** Para agentes con rol `operador`, `server/src/routes/conversation.routes.js` (`GET /`) filtra por `assignedTo` (departamento o email del agente) antes de llegar al frontend — así que un operador solo ve archivadas de su propio departamento, nunca el archivo completo.

**Ya funciona y no requiere cambios:** cuando un cliente le escribe a una conversación con `status` `resolved` o `bot_archived`, `server/src/services/bot.service.js` (dentro de `processIncomingMessageInternal`) ya la reabre automáticamente — resetea `status` a `'bot'`, `humanMode` a `false` y `assignedTo` a `null` antes de procesar el mensaje entrante. El bot vuelve a atender el chat sin intervención manual.

## Objetivo

Que la pestaña "Archivos" sea un tacho real: todo agente, sin importar su rol o departamento, ve el historial completo de conversaciones archivadas o resueltas alguna vez, sin límite de cantidad ni de antigüedad.

## Alcance y permisos

- El nuevo endpoint no aplica ninguna restricción de `assignedTo`/departamento — aplica a todos los roles por igual (admin, atención al cliente, operador).
- Sin límite de resultados: se listan todas las conversaciones con `status` `resolved` o `bot_archived`, sin importar cuándo se archivaron.
- Este cambio es exclusivo de la pestaña "Archivos". El resto de las pestañas (`GET /api/conversations`, límite 200, restricción por departamento para `operador`) no se modifica.
- No se toca la lógica de reapertura automática (`bot.service.js`) — ya cumple lo pedido.

## Diseño

### Backend — nuevo endpoint

`GET /api/conversations/archived`

Nueva función `listArchivedConversations()` en `server/src/services/conversation.service.js`, reutilizando el helper `mapConversationDoc` ya introducido para la búsqueda global:

```js
export async function listArchivedConversations() {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION)
    .where('status', 'in', ['resolved', 'bot_archived'])
    .get();
  return snapshot.docs
    .map(doc => mapConversationDoc(doc, doc.data()))
    .sort((a, b) => tsToMs(b.updatedAt) - tsToMs(a.updatedAt));
}
```

Se ordena en memoria (no con `orderBy` de Firestore) para evitar depender de un índice compuesto `status + updatedAt` que hoy no existe en el proyecto — la consulta `where('status', 'in', [...])` sola no lo requiere.

Ruta nueva en `server/src/routes/conversation.routes.js`, sin aplicar ningún filtro de `assignedTo`:

```js
router.get('/archived', async (req, res) => {
  try {
    const conversations = await listArchivedConversations();
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Frontend (`client/src/pages/Conversations.jsx`)

- Nuevo estado `archivedConversations` (`null` hasta cargar) y `loadingArchived`.
- Cuando la pestaña activa (`filter`) pasa a `'archived'`, se dispara `loadArchivedConversations()` contra el nuevo endpoint. Se vuelve a cargar cada vez que se entra a esa pestaña (no hace falta polling continuo tipo chat en vivo, es un archivo histórico).
- En el cálculo de `filtered`: cuando `filter === 'archived'` y no hay búsqueda activa (`searchResults === null`), se usa `archivedConversations` en vez de derivarlo de `conversations`, aplicando igual el filtro de etiquetas (`labelFilter`) que ya existe para mantener consistencia con las demás pestañas.
- Se elimina la rama `else if (filter === 'archived') { if (!isConvArchived) return false; }` del predicado compartido, ya que esa pestaña deja de depender del array `conversations`.
- El resto de las pestañas (bot/mios/crítico/urgente/esperando/equipos/todos) no cambia: siguen derivándose de `conversations`, que sigue excluyendo archivadas como hasta ahora.

## Límites conocidos (aceptados para esta iteración)

- El endpoint no pagina: si el archivo histórico crece mucho (varios miles de conversaciones), la respuesta y el render de la lista se vuelven más pesados con el tiempo. Igual que en la búsqueda global, se acepta este trade-off para esta iteración; paginación queda como mejora futura si hace falta.

## Fuera de alcance

- No se modifica la lógica de reapertura automática en `bot.service.js` (ya cumple lo pedido).
- No se pagina ni se agrega scroll infinito a la lista de archivados.
- No se cambia el comportamiento de las demás pestañas ni del listado principal (`GET /api/conversations`).

## Testing

Sin framework de testing en el proyecto (decisión ya tomada en la feature de búsqueda global) — verificación manual:
- Confirmar con curl que `GET /api/conversations/archived` devuelve conversaciones archivadas de distintos departamentos, logueado como un agente `operador` de un departamento específico.
- Confirmar en el navegador que una conversación archivada vieja (fuera del top-200 por `updatedAt`) aparece en la pestaña "Archivos".
- Confirmar que el filtro de etiquetas sigue funcionando dentro de la pestaña "Archivos".
- Confirmar que las demás pestañas no cambiaron su comportamiento.
