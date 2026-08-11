# Corrección de cálculos en Estadísticas

## Contexto

El usuario reportó que la página de Estadísticas "no da mucha info" y sospecha que hay datos mal calculados. Auditoría de `server/src/routes/stats.routes.js` y `client/src/pages/Stats.jsx` confirmó 5 bugs concretos (no percepción):

1. La consulta base filtra por `createdAt >= inicio del período`, así que "Estadísticas de 7 días" solo muestra conversaciones **creadas** en esos 7 días, no la actividad real del período. Una conversación abierta hace un mes y resuelta hoy no aparece en ningún lado.
2. El bucket "Urgente" de "Por estado" cuenta `status === 'urgent'`, un valor legado que casi ninguna conversación actual tiene (el campo real es el booleano `conv.urgent`). La barra "Urgente" da ~0 casi siempre.
3. `bot_archived` se suma al total y al KPI "Resueltas" pero no tiene bucket propio en "Por estado" — las barras nunca suman el 100% del total.
4. "Bot autónomo %" cuenta conversaciones cuyo asignado actual es el bot, pero una conversación que fue escalada, resuelta por un agente, y reabierta al bot vuelve a contar como resuelta autónomamente.
5. El tiempo de primera respuesta "Por departamento" se pierde en el caso más común: cuando un agente puntual toma una conversación derivada a su departamento (`take_over`), `assignedTo` pasa de ser el ID del departamento al email del agente, y la métrica solo mira conversaciones cuyo `assignedTo` actual sigue siendo el departamento.

## Objetivo

Corregir los 5 cálculos sin cambiar el resto de la página (agregar info nueva queda para una conversación aparte).

## Diseño

### Bug 1 — Base de datos del período

Cambiar la query base en `router.get('/')`:

```js
db.collection('bot-altorancho_conversations').where('createdAt', '>=', startTs).get()
```
→
```js
db.collection('bot-altorancho_conversations').where('updatedAt', '>=', startTs).get()
```

Es un cambio seguro: toda conversación nueva tiene `updatedAt === createdAt` en el momento de crearse (`getOrCreateConversation` los setea iguales), así que el nuevo conjunto es un superset estricto del actual — no se pierde ninguna conversación que ya se contaba, solo se suman las que tuvieron actividad real en el período sin haber sido creadas en él.

Con este conjunto más amplio, dos métricas necesitan volver a acotarse por su propio timestamp (para no arrastrar eventos viejos que solo causaron un `updatedAt` incidental):

- **Resueltas** (`resolved`): en vez de "status actual es resolved/bot_archived", contar conversaciones cuyo `resolvedAt` cae dentro de `[inicio del período, ahora]`.
- **Escalación** (`escalatedCount`, `escalationRate`, y las muestras de `avgFirstResponseMin`): en vez de "tiene `escalatedAt` en algún momento o status actual escalated", contar conversaciones cuyo `escalatedAt` cae dentro de `[inicio del período, ahora]`.

`byAgent`/`byDepartment` (handled/resolved) siguen atribuyendo por el `assignedTo` **actual** — es el único dato que persiste Firestore (no hay historial de reasignaciones). Si una conversación cambió de agente durante el período, solo el último asignado se lleva el crédito. Se deja documentado como limitación conocida, no se resuelve en este cambio (implicaría agregar un log de eventos, fuera de alcance).

`dailyTrend` (conversaciones creadas por día) no cambia de lógica — sigue construyéndose a partir de `conv.createdAt` de cada conversación del conjunto, y como el conjunto ahora es un superset, el resultado no pierde precisión.

### Bug 2 + 3 — Reestructurar "Por estado" y separar "Urgente"

- `byStatus` pasa a tener 4 claves reales y mutuamente excluyentes: `bot`, `escalated`, `resolved`, `bot_archived` (agregar esta última, que hoy falta). Con esto las barras de "Por estado" siempre suman el `total` exacto.
- Se quita `urgent` de `byStatus`.
- Nuevo campo en la respuesta: `urgentCount` = cantidad de conversaciones **actualmente abiertas** (no resolved/bot_archived) con `urgent === true` — mismo criterio que ya usa el filtro "Urgentes" en la página de Conversaciones (`client/src/pages/Conversations.jsx`, filtro `urgent`). Este conteo se calcula sobre el listado completo de conversaciones abiertas, no limitado al período, porque "urgente" es un estado presente, no un evento histórico — tiene sentido que sea siempre "urgentes ahora mismo", igual que la tarjeta "Pendientes" ya existente.
- Frontend (`Stats.jsx`): se quita `urgent` de `STATUS_META` y de las barras de "Por estado"; se agrega una tarjeta KPI nueva "Urgentes" en la fila de KPIs (junto a "Pendientes"), mostrando `data.urgentCount`.
- `STATUS_META` gana la entrada `bot_archived: { label: 'Archivado por bot', color: ... }` para la barra nueva.

### Bug 4 — "Bot autónomo %" basado en `escalatedAt`

Cambiar la definición: en vez de `agentBuckets['bot'].handled / total` (conversaciones cuyo asignado actual es el bot), contar conversaciones del conjunto del período que **nunca** tuvieron `escalatedAt` (`!conv.escalatedAt`), dividido por `total`. Una conversación que fue escalada y después devuelta al bot ya no cuenta como resuelta de forma autónoma, sin importar su `assignedTo` actual.

### Bug 5 — Atribución de tiempo de respuesta por departamento vía el agente

Hoy la muestra de tiempo de primera respuesta solo se agrega a `deptBuckets[assignee]` si `deptIds.has(assignee)` (o sea, el asignado actual es literalmente un ID de departamento). Se agrega un paso intermedio: si el asignado actual es un agente individual, buscar su `department` (campo ya existente en `bot-altorancho_agents`, ya se trae en la query `agentsSnap` de este mismo endpoint) y usar ese departamento como destino de la muestra, en vez de descartarla.

```js
function resolveDeptForAssignee(assignee, deptIds, agentsByEmail) {
  if (deptIds.has(assignee)) return assignee;
  const agent = agentsByEmail.get(assignee);
  return agent?.department && deptIds.has(agent.department) ? agent.department : null;
}
```

Este helper se usa tanto para las muestras de tiempo de respuesta como para `handled`/`resolved` "Por departamento" — así un caso derivado a Facturación y tomado por un agente de Facturación sigue contando para Facturación en vez de perderse. Antes esas conversaciones ya no se contaban en absoluto en `byDepartment` una vez que un agente las tomaba (mismo bug que el de respuesta, aplicado a los conteos de handled/resolved).

## Fuera de alcance

- Agregar información nueva a Estadísticas (queda para una conversación aparte, ya acordado con el usuario).
- Historial de reasignaciones entre agentes (requeriría un log de eventos nuevo).
- Cambios a la métrica "critical" (separada de "urgent", no mencionada en los bugs reportados).
