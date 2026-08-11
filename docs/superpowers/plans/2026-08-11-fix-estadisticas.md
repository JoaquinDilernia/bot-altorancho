# Corrección de cálculos en Estadísticas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corregir los 5 bugs de cálculo encontrados en Estadísticas: alcance del período basado en `createdAt` en vez de actividad real, bucket "Urgente" muerto, `bot_archived` ausente del desglose por estado, "Bot autónomo %" inflado, y pérdida de atribución de tiempo de respuesta por departamento cuando un agente puntual toma el caso.

**Architecture:** Todos los cambios de backend viven en un único endpoint (`GET /api/stats`, `server/src/routes/stats.routes.js`) — se corrigen los 5 juntos porque comparten el mismo bucle sobre `conversations` y el mismo objeto de respuesta. El frontend (`client/src/pages/Stats.jsx`) se ajusta para reflejar la nueva forma de `byStatus` (sin `urgent`, con `bot_archived`) y el nuevo campo `urgentCount` como tarjeta KPI separada.

**Tech Stack:** Node.js (ESM) + Express, Firestore. React + Vite. Sin framework de testing en este repo — verificación con `node -e` scripts contra Firestore real, curl, build y navegador.

## Global Constraints

- No agregar información nueva a Estadísticas (eso es una conversación aparte, ya acordada).
- No tocar la métrica "critical" (separada de "urgent", no reportada como bug).
- `byAgent`/`byDepartment` siguen atribuyendo por el `assignedTo` **actual** — no hay historial de reasignaciones en el esquema, no se agrega en este cambio.
- Spec de referencia: `docs/superpowers/specs/2026-08-11-fix-estadisticas-design.md`.

---

### Task 1: Backend — corregir los 5 cálculos en `stats.routes.js`

**Files:**
- Modify: `server/src/routes/stats.routes.js` (reescritura completa del handler `GET /`, más helpers nuevos)

**Interfaces:**
- Produces: la respuesta de `GET /api/stats?period=...` cambia de forma: `byStatus` pasa a `{ bot, escalated, resolved, bot_archived }` (sin `urgent`), se agrega `urgentCount` (number) al nivel superior. El resto de los campos (`total`, `resolved`, `pending`, `botResolutionRate`, `escalationRate`, `avgFirstResponseMin`, `avgResolutionMin`, `byAgent`, `byDepartment`, `labelCounts`, `dailyTrend`) mantienen los mismos nombres, consumidos por Task 2 (frontend).

- [ ] **Step 1: Agregar helpers nuevos**

Insertar después de la función `diffMin` existente (después de la línea 43, `}`):

```js
function isInPeriod(ts, startMs) {
  const d = toDate(ts);
  return !!d && d.getTime() >= startMs;
}

function resolveDeptForAssignee(assignee, deptIds, agentsByEmail) {
  if (deptIds.has(assignee)) return assignee;
  const agent = agentsByEmail.get(assignee);
  return agent?.department && deptIds.has(agent.department) ? agent.department : null;
}
```

- [ ] **Step 2: Cambiar la query base de `createdAt` a `updatedAt` y agregar la query de urgentes**

Old:
```js
    const [snap, agentsSnap, deptsSnap] = await Promise.all([
      db.collection('bot-altorancho_conversations').where('createdAt', '>=', startTs).get(),
      db.collection('bot-altorancho_agents').get(),
      db.collection('bot-altorancho_departments').get(),
    ]);

    const conversations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const agents = agentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const departments = deptsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const deptIds = new Set(departments.map(d => d.id));
```

New:
```js
    const [snap, agentsSnap, deptsSnap, urgentSnap] = await Promise.all([
      db.collection('bot-altorancho_conversations').where('updatedAt', '>=', startTs).get(),
      db.collection('bot-altorancho_agents').get(),
      db.collection('bot-altorancho_departments').get(),
      db.collection('bot-altorancho_conversations').where('urgent', '==', true).get(),
    ]);

    const conversations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const agents = agentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const departments = deptsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const deptIds = new Set(departments.map(d => d.id));
    const agentsByEmail = new Map(agents.map(a => [a.email, a]));

    // Urgentes: siempre "ahora mismo", sin acotar por período (igual criterio
    // que la tarjeta "Pendientes" y el filtro "Urgentes" de Conversaciones).
    const urgentCount = urgentSnap.docs
      .map(d => d.data())
      .filter(c => c.status !== 'resolved' && c.status !== 'bot_archived')
      .length;
```

Nota: `where('updatedAt', '>=', startTs)` es seguro porque `getOrCreateConversation` setea `updatedAt === createdAt` al crear una conversación — el nuevo conjunto es un superset estricto del anterior, nunca pierde conversaciones que ya se contaban.

- [ ] **Step 3: Corregir `byStatus` (agregar `bot_archived`, quitar `urgent`, normalizar legado)**

Old:
```js
    const byStatus  = { bot: 0, urgent: 0, escalated: 0, resolved: 0 };
```

New:
```js
    const byStatus  = { bot: 0, escalated: 0, resolved: 0, bot_archived: 0 };
```

Y en el bucle principal:

Old:
```js
    for (const conv of conversations) {
      const status   = conv.status  ?? 'bot';
      const channel  = conv.channel ?? 'whatsapp';
      const assignee = conv.assignedTo ?? 'bot';

      if (status in byStatus)   byStatus[status]++;
      if (channel in byChannel) byChannel[channel]++;
```

New:
```js
    for (const conv of conversations) {
      const rawStatus = conv.status ?? 'bot';
      const status    = rawStatus === 'urgent' ? 'bot' : rawStatus; // legado: 'urgent' era status, ahora es flag
      const channel   = conv.channel ?? 'whatsapp';
      const assignee  = conv.assignedTo ?? 'bot';

      if (status in byStatus)   byStatus[status]++;
      if (channel in byChannel) byChannel[channel]++;
```

- [ ] **Step 4: Corregir atribución por departamento (bug 5) y escalación acotada al período (bug 1)**

Old:
```js
      // Department breakdown
      if (deptIds.has(assignee) && deptBuckets[assignee]) {
        deptBuckets[assignee].handled++;
        if (status === 'resolved' || status === 'bot_archived') deptBuckets[assignee].resolved++;
      }

      // Escalation tracking
      if (conv.escalatedAt || status === 'escalated') {
        escalatedCount++;
        // First response time: escalatedAt → firstAgentResponseAt
        const respMin = diffMin(conv.escalatedAt, conv.firstAgentResponseAt);
        if (respMin !== null && respMin >= 0 && respMin < 24 * 60) {
          firstResponseSamples.push(respMin);
          if (deptIds.has(assignee)) deptBuckets[assignee]._responseSamples.push(respMin);
        }
      }
```

New:
```js
      // Department breakdown — resolver el depto real aunque el asignado
      // actual sea un agente puntual que tomó un caso derivado (take_over)
      const resolvedDept = resolveDeptForAssignee(assignee, deptIds, agentsByEmail);
      if (resolvedDept && deptBuckets[resolvedDept]) {
        deptBuckets[resolvedDept].handled++;
        if (status === 'resolved' || status === 'bot_archived') deptBuckets[resolvedDept].resolved++;
      }

      // Escalation tracking: solo escalaciones ocurridas dentro del período
      if (isInPeriod(conv.escalatedAt, start.getTime())) {
        escalatedCount++;
        // First response time: escalatedAt → firstAgentResponseAt
        const respMin = diffMin(conv.escalatedAt, conv.firstAgentResponseAt);
        if (respMin !== null && respMin >= 0 && respMin < 24 * 60) {
          firstResponseSamples.push(respMin);
          if (resolvedDept) deptBuckets[resolvedDept]._responseSamples.push(respMin);
        }
      }
```

- [ ] **Step 5: Corregir "Resueltas" (bug 1) y "Bot autónomo %" (bug 4)**

Old:
```js
    // --- Derived metrics ---
    const total = conversations.length;
    const resolved = byStatus.resolved + (conversations.filter(c => c.status === 'bot_archived').length);
    const botHandledPct = total > 0 ? Math.round((agentBuckets['bot'].handled / total) * 100) : 0;
    const pending = conversations.filter(c => {
      const s = c.status ?? 'bot';
      return s !== 'resolved' && s !== 'bot_archived';
    }).length;
```

New:
```js
    // --- Derived metrics ---
    const total = conversations.length;
    const resolved = conversations.filter(c => isInPeriod(c.resolvedAt, start.getTime())).length;
    const neverEscalatedCount = conversations.filter(c => !c.escalatedAt).length;
    const botHandledPct = total > 0 ? Math.round((neverEscalatedCount / total) * 100) : 0;
    const pending = conversations.filter(c => {
      const s = c.status ?? 'bot';
      return s !== 'resolved' && s !== 'bot_archived';
    }).length;
```

- [ ] **Step 6: Agregar `urgentCount` a la respuesta**

Old:
```js
    res.json({
      period,
      total,
      resolved,
      botResolutionRate: botHandledPct,
      pending,
      escalatedCount,
```

New:
```js
    res.json({
      period,
      total,
      resolved,
      botResolutionRate: botHandledPct,
      pending,
      urgentCount,
      escalatedCount,
```

- [ ] **Step 7: Verificar que el archivo importa sin errores de sintaxis**

Run desde `server/`: `node -e "
import('./src/routes/stats.routes.js').then(() => {
  console.log('stats.routes.js importa sin errores');
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"`

Expected: imprime `stats.routes.js importa sin errores`, sin excepciones. La verificación funcional real (contra datos de Firestore) se hace en el Step 8 vía curl, con el server corriendo.

- [ ] **Step 8: Levantar el server y probar los 3 períodos con curl**

Run: `cd server && npm run dev` (en background). Con un token de agente válido:

```bash
curl -s "http://localhost:<PUERTO>/api/stats?period=week" -H "Authorization: Bearer <TOKEN>" | python3 -m json.tool
```

Expected, para cada período (`day`, `week`, `month`):
- `byStatus.bot + byStatus.escalated + byStatus.resolved + byStatus.bot_archived === total` (las barras ahora suman el total exacto).
- `byStatus` no tiene la clave `urgent`.
- `urgentCount` es un número (puede ser 0 si no hay urgentes activas, pero el campo existe).
- `resolved` es un número ≥ 0 y no necesariamente igual a `byStatus.resolved` (son métricas distintas a propósito — una es "resuelto dentro del período", la otra es "status actual entre las tocadas en el período").
- Repetir con `period=week` después de que un agente resuelva alguna conversación vieja (creada antes del período, tocada ahora) y confirmar que el `total` de `week` es mayor o igual al `total` que daba antes del fix (evidencia de que ahora se cuenta actividad, no solo creación).

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/stats.routes.js
git commit -m "fix(stats): corregir alcance de período, bucket urgente, bot_archived, bot autónomo y atribución por departamento"
```

---

### Task 2: Frontend — reflejar el nuevo `byStatus` y agregar la tarjeta "Urgentes"

**Files:**
- Modify: `client/src/pages/Stats.jsx` (`STATUS_META`, fila de KPIs)
- Modify: `client/src/pages/Stats.module.css` (`.kpiRow` pasa de 4 a 5 columnas)

**Interfaces:**
- Consumes: `data.byStatus` (ahora sin `urgent`, con `bot_archived`) y `data.urgentCount` (Task 1).

- [ ] **Step 1: Actualizar `STATUS_META`**

Old:
```js
const STATUS_META = {
  bot:       { label: 'Bot activo', color: 'var(--color-primary)' },
  urgent:    { label: 'Urgente',    color: 'var(--color-status-urgent)' },
  escalated: { label: 'Escalado',   color: '#8b5cf6' },
  resolved:  { label: 'Resuelto',   color: 'var(--color-status-resolved)' },
};
```

New:
```js
const STATUS_META = {
  bot:          { label: 'Bot activo',        color: 'var(--color-primary)' },
  escalated:    { label: 'Escalado',          color: '#8b5cf6' },
  resolved:     { label: 'Resuelto',          color: 'var(--color-status-resolved)' },
  bot_archived: { label: 'Archivado por bot', color: '#94a3b8' },
};
```

- [ ] **Step 2: Agregar la tarjeta KPI "Urgentes"**

Old:
```jsx
            <KpiCard
              title="Pendientes" value={data.pending}
              sub="activas sin resolver"
              accent={data.pending > 0 ? 'var(--color-status-urgent)' : undefined}
            />
          </div>
```

New:
```jsx
            <KpiCard
              title="Pendientes" value={data.pending}
              sub="activas sin resolver"
              accent={data.pending > 0 ? 'var(--color-status-urgent)' : undefined}
            />
            <KpiCard
              title="Urgentes" value={data.urgentCount}
              sub="abiertas y marcadas urgentes"
              accent={data.urgentCount > 0 ? 'var(--color-status-urgent)' : undefined}
            />
          </div>
```

- [ ] **Step 3: Ajustar el grid de la fila de KPIs a 5 columnas**

En `client/src/pages/Stats.module.css`:

Old:
```css
.kpiRow {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-4);
}
```

New:
```css
.kpiRow {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-4);
}
```

- [ ] **Step 4: Build para verificar sintaxis**

Run: `cd client && npm run build`
Expected: build exitoso, sin errores.

- [ ] **Step 5: Prueba manual en el navegador**

Abrir Estadísticas, probar los 3 períodos (Hoy / 7 días / 30 días) y confirmar:
1. "Por estado" muestra 4 barras (Bot activo, Escalado, Resuelto, Archivado por bot) que suman el total.
2. La fila de KPIs muestra 5 tarjetas, con "Urgentes" al lado de "Pendientes", sin romper el layout.
3. Ningún valor queda en blanco/`NaN`/`undefined` en pantalla.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Stats.jsx client/src/pages/Stats.module.css
git commit -m "fix(stats): reflejar bucket bot_archived y tarjeta Urgentes en el frontend"
```
