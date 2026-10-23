# Panel "WhatsApp nativo" en ALTORANCHO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Llevar el panel rediseñado de BOT-TECHDI a BOT-ALTORANCHO con paleta de Alto, Poppins y bot "Alto", sin perder ninguna función de Alto.

**Architecture:** Se porta el código de TechDI (rango `cf0916d~1..1b526df` en `../BOT-TECHDI`, más las funciones genéricas de Conversaciones previas a ese rango) sobre los archivos de Alto. Backend primero, aditivo (el panel viejo sigue andando). Después la base del cliente (tokens, marca, piezas compartidas), y por último cada pantalla re-agregando lo propio de Alto. Cuando TechDI y Alto hacen lo mismo distinto, gana el comportamiento de Alto.

**Tech Stack:** React 18 + Vite + CSS Modules (cliente), Node ESM + Express + Firestore (servidor, colecciones `bot-altorancho_*`), `node --test` en server, vitest en cliente (se agrega como en TechDI).

**Spec:** `docs/superpowers/specs/2026-10-23-panel-whatsapp-nativo-alto-design.md` (y el de referencia `../BOT-TECHDI/docs/superpowers/specs/2026-10-20-panel-whatsapp-nativo-design.md`).

## Global Constraints

- Rama `panel-whatsapp-nativo`. El backend (Tasks 1-2) se puede mergear a main antes; el cliente se mergea una sola vez al final (Task 9).
- Color de marca por defecto `#343535`; fondo `#f5f2ee`; tipografía **Poppins** (no Figtree). Nombre del bot por defecto **"Alto"**.
- Cero textos "TeDi" / "TechDI" en el cliente de Alto (salvo comentarios de origen).
- Globos salientes verde WhatsApp `#d9fdd3`, fondo de chat con dibujitos y avisos amarillos se mantienen.
- Sin dependencias nuevas salvo `vitest` (devDependency del cliente).
- Endpoints nuevos aditivos; no se cambia la forma de los campos que el panel viejo usa (`/api/stats` conserva `byStatus`, `byChannel`, `byDepartment`, `byAgent`, `labelCounts`, `dailyTrend`, `urgentCount`, `awaitingAgent`, `oldestAwaitingMin`, etc.).
- `prefers-reduced-motion` respetado; mobile sigue funcionando.
- No tocar ni commitear los archivos sin trackear ("Copia en conflicto…", `server/_tmp-*.mjs`, `docs/ig-app-review/`). Usar `git add` con rutas explícitas.
- Cada archivo editado conserva su fin de línea (algunos son CRLF).

## Review Focus

1. **Chats de Instagram:** cuentan como esperando, se ven con su indicador de canal, no se ofrecen como destino de reenvío, y responder sigue usando la vía de IG. → tests en Task 1 (`isWaiting` con `channel: 'instagram'`) y Task 2 (`forwardTargetsAllowed`).
2. **Conversación con `status: 'urgent'` (legado) o `urgent: true`:** se trata como bot/urgente igual que hoy y, si está escalada sin atender, cuenta como esperando. → test en Task 1.
3. **Operador (rol más bajo):** entra a Conversaciones (no al Dashboard), ve el menú sin las pantallas que no le corresponden y la marca le carga igual. → verificación en Task 4 y Task 9.
4. **Restos de TechDI:** el nombre del bot, el negocio y el color salen de `bot_config`, nunca de un literal. → grep en Task 9.
5. **Período "Elegir fechas" y "Hoy"** con `previous` y `byBusinessHours` sin datos (0 conversaciones): las variaciones muestran "—" y no `NaN`/`Infinity`. → test en Task 1.

---

### Task 1: Agregación de estadísticas y regla única de "esperando" (server)

**Files:**
- Create: `server/src/services/statsAggregate.js`, `statsAggregate.test.js`, `businessHours.js`, `businessHours.test.js`, `waiting.js`, `waiting.test.js`
- Modify: `server/src/routes/stats.routes.js` (`GET /`), `server/src/services/bot.service.js` (usar `isWithinBusinessHoursAt`)

**Interfaces:**
- Produces (mismos nombres que TechDI): `previousRange(startMs, endMs) -> { startMs, endMs }`, `aggregateConversations(conversations, { startMs, endMs, agents, departments, botConfig }) -> stats`, `isWithinBusinessHoursAt(date, botConfig) -> boolean`, `isWaiting(conv, agentKeys) -> boolean`, `waitingSummary(conversations, agents, now) -> { count, oldestMin }`, `agentKeySet(agents) -> Set`.
- `/api/stats` agrega `previous` (mismos totales sobre el rango anterior) y `byBusinessHours: { inside, outside }`; conserva todos los campos actuales de Alto. `awaitingAgent` y `oldestAwaitingMin` salen de `waitingSummary`.

- [ ] **Step 1: Portar los tests de TechDI** (`../BOT-TECHDI/server/src/services/{statsAggregate,businessHours,waiting}.test.js`) adaptando `areas`→`departments`, y agregar:
  - `isWaiting({ status: 'escalated', channel: 'instagram' }, new Set())` → `true`
  - `isWaiting({ status: 'urgent', humanMode: true }, new Set())` → `true` (legado)
  - `isWaiting({ status: 'escalated', urgent: true, assignedTo: 'a1' }, new Set(['a1']))` → `false`
  - `aggregateConversations([], …)` → `previous` con totales 0 y `byBusinessHours` `{ inside: 0, outside: 0 }`; ninguna tasa es `NaN`.
  - el agregado incluye `byStatus`, `byChannel`, `byDepartment` con la misma forma que hoy devuelve `stats.routes.js`.
- [ ] **Step 2:** `cd server && npm test` → fallan por módulos inexistentes.
- [ ] **Step 3:** Portar los servicios de TechDI; mover la agregación actual de `stats.routes.js` a `aggregateConversations` sin cambiar la salida existente (incluye legado `'urgent'`→`'bot'`, departamentos, canal, carritos no se tocan). `isWaiting` trata `status === 'urgent'` como `'bot'`.
- [ ] **Step 4:** `npm test` → PASS (los 127 previos + nuevos).
- [ ] **Step 5:** Comparar `GET /api/stats?period=week` local vs producción: mismos valores en los campos viejos. Commit `feat(stats): período anterior, día vs noche y regla única de esperando`.

### Task 2: Endpoints livianos, marca y reenviar (server)

**Files:**
- Modify: `server/src/app.js`, `server/src/routes/config.routes.js`, `server/src/routes/conversation.routes.js`
- Create: `server/src/services/forward.js`, `forward.test.js`

**Interfaces:**
- Consumes: `waitingSummary` (Task 1).
- Produces: `GET /api/stats/waiting -> { count, oldestMin }` (todo rol); `GET /api/config/brand -> { botName, brandColor, businessName }` (todo rol; defaults `"Alto"`, `"#343535"`, `"Alto Rancho"`); `PUT /api/config` acepta `brandColor` (hex validado); `POST /api/conversations/forward { messages, targets }` como TechDI; los endpoints livianos que agregó TechDI en `5274154` para el Dashboard.
- `forwardTargetsAllowed(targets, conversationsById, now) -> { allowed: string[], rejected: { id, reason }[] }`.

- [ ] **Step 1: Tests de `forwardTargetsAllowed`:** destino con `channel: 'instagram'` → rechazado `reason: 'instagram'`; destino WhatsApp con último mensaje del cliente hace >24 h → `reason: 'window_closed'`; WhatsApp dentro de 24 h → permitido; máximo 10 destinos.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Portar de TechDI (`app.js`, `config.routes.js`, `conversation.routes.js:534-630`) usando colecciones `bot-altorancho_*` y el envío de Meta de Alto; el origen puede ser IG.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(server): marca, contador de espera liviano y reenviar`. Merge a main + push (deploy aditivo); verificar `/health` y que el panel viejo en producción sigue cargando Conversaciones y Estadísticas.

### Task 3: Base del cliente — tokens, marca y piezas compartidas

**Files:**
- Modify: `client/package.json` (vitest + script `test` que corra vitest y los tests `node --test` existentes de `src/utils`), `client/src/styles/global.css`, `client/src/App.jsx`, `client/src/pages/Config.jsx` (+css)
- Create (de TechDI): `client/src/lib/{brand,motion,conversationView,home,statsView}.js` + tests, `client/src/contexts/BrandContext.jsx`, `client/src/hooks/{useCountUp,useFirstLoad}.js`, `client/src/components/ui/{BotFace,Skeleton}.jsx` + css

**Interfaces:**
- Produces: `useBrand() -> { botName, brandColor, businessName, updateBrand }`; `DEFAULT_BRAND = '#343535'`; `<BotFace size />`, `<Skeleton />`; `pillFor(conv, me, agents)`, helpers de `home.js` y `statsView.js` con las firmas de TechDI.

- [ ] **Step 1:** Portar los tests de lib; cambiar expectativas de `brand.test.js` a `#343535`; agregar test de `conversationView`: conversación `channel: 'instagram'` escalada → píldora "Esperando".
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Portar archivos. Tokens de TechDI en `global.css` mapeados a la paleta de Alto (variables `--color-*` actuales siguen existiendo para las pantallas que las usan); `--font-sans` sigue en Poppins. Defaults de `BrandContext`: `botName: 'Alto'`, `businessName: 'Alto Rancho'`. Config: campos nombre del bot y color de marca como TechDI.
- [ ] **Step 4:** `npm test` y `npm run build` → PASS. Si texto sobre `--brand` no contrasta, ajustar el derivado en `brandVars`.
- [ ] **Step 5:** Commit `feat(panel): tokens WhatsApp nativo con paleta de Alto y marca configurable`.

### Task 4: Menú agrupado

**Files:** Modify `client/src/components/Layout/Layout.jsx` (+css), `client/src/App.jsx` (`homePath`, landing por rol).

- [ ] **Step 1:** Portar Layout de TechDI (`1b526df`). Grupos: sin grupo Dashboard, Conversaciones, Estadísticas; **Clientes:** Contactos, Difusiones, Pagos pendientes; **Operación:** SimpliRoute, Notificaciones; **Equipo:** Usuarios, Departamentos; **Configuración:** Knowledge Base, Etiquetas, Resp. rápidas, Plantillas, Simulador, Configuración, Costos. Conservar `minRole` actuales e íconos de Alto. Contador de esperando desde `/api/stats/waiting`. Desplegables cerrados al cargar.
- [ ] **Step 2:** `npm run dev` contra producción (`VITE_API_URL` de `.env`); verificar en Chrome como admin: todas las rutas abren; mobile (ancho 390) abre/cierra menú.
- [ ] **Step 3:** Commit `feat(panel): menú agrupado con Dashboard primero`.

### Task 5: Conversaciones

**Files:** Modify `client/src/pages/Conversations.jsx`, `Conversations.module.css`.

- [ ] **Step 1:** Inventario antes de tocar: listar en `docs/superpowers/plans/alto-conversaciones-checklist.md` cada función de Alto hoy (anti-objetivos del spec) y cada función genérica de TechDI que falta (reenviar con `ForwardModal`, buscar en el chat con resaltado, `ConvAvatar`, subtítulo de contacto, adjuntos con tipo/tamaño, `isWaWindowClosed`, tiempo de grabación, avisos de traspaso, firma del bot con `BotFace`, píldora de estado, chips de filtro y de respuestas rápidas).
- [ ] **Step 2:** Portar el diseño de TechDI re-agregando lo de Alto (Instagram, `slaColor`, `AgentBadge`, `StatusChip`, pedidos TiendaNube, departamentos, plantillas, notas, resumen, motivo de fallo). La firma del bot usa `useBrand().botName`.
- [ ] **Step 3:** `npm test` + `npm run build` → PASS.
- [ ] **Step 4:** Recorrer el checklist en Chrome contra producción, sin enviar mensajes a clientes reales (reenviar/responder solo a un chat de prueba del usuario si lo autoriza). Tildar cada ítem.
- [ ] **Step 5:** Commit `feat(conversaciones): diseño WhatsApp nativo con funciones de TechDI`.

### Task 6: Dashboard (Inicio)

**Files:** Modify `client/src/pages/Dashboard.jsx` (+css).

- [ ] **Step 1:** Portar Dashboard de TechDI: globo de "Alto" con `home.js`, 4 números con sparkline, "Te esperan" (naranja ≥5 min, rojo ≥15 min, incluye IG), "Pasando ahora". Si el Dashboard actual de Alto muestra algo que el nuevo no, se agrega como tarjeta al final.
- [ ] **Step 2:** Verificar en Chrome; animaciones solo en la primera carga; reduced-motion sin animación.
- [ ] **Step 3:** Commit `feat(inicio): Alto resume el día, cola de espera y actividad`.

### Task 7: Estadísticas

**Files:** Modify `client/src/pages/Stats.jsx` (+css).

- [ ] **Step 1:** Portar Stats de TechDI (chips de período, tarjeta estrella "Resolvió Alto solo X%", tiles con variación, apiladas por día, día vs noche, dona por canal WhatsApp/Instagram, barras por departamento, ranking por agente, etiquetas con su detalle). Mantener al final "Por estado" y `BotCartStats` ("Carritos del bot") con el estilo nuevo.
- [ ] **Step 2:** Verificar en Chrome que cada número que mostraba el Stats viejo aparece en el nuevo con el mismo valor (comparar contra producción antes de subir).
- [ ] **Step 3:** Commit `feat(estadisticas): métrica estrella, día vs noche y secciones de Alto`.

### Task 8: Pasada de estilo a pantallas propias

**Files:** `*.module.css` de Customers, Campaigns (+`components/Campaigns`), PaymentReminders, SimpliRouteHistory, Notifications, Departments, Labels, QuickReplies, Templates, KnowledgeBase, Simulator, Config, Costs, Users, Profile, Login.

- [ ] **Step 1:** Solo CSS (y markup mínimo): tokens nuevos, sin borde lateral de color, sin etiquetas en mayúscula chiquita, botones/tarjetas como TechDI. Sin cambios de lógica.
- [ ] **Step 2:** Abrir cada pantalla en Chrome (desktop y 390 px) y confirmar que se ve y carga datos.
- [ ] **Step 3:** Commit `style(panel): pantallas de Alto con el estilo nuevo`.

### Task 9: Verificación final y entrega

- [ ] **Step 1:** `grep -rn "TeDi\|TechDI\|techdi" client/src` → sin resultados en textos visibles.
- [ ] **Step 2:** `npm test` (client y server) y `npm run build` → PASS.
- [ ] **Step 3:** Recorrido completo en Chrome como admin y como operador (si el usuario da un login de operador de prueba; si no, revisar por código `minRole`/`homePath`).
- [ ] **Step 4:** Merge de la rama a main + push. Avisar al usuario que suba `client/dist` (primero `assets/*.js`/`*.css`, después `index.html`) y que configure "Alto" y el color en Config si quiere otro.
