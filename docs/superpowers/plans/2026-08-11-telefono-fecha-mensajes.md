# Teléfono en perfil + fecha en mensajes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar el teléfono del cliente en el panel de perfil, y la fecha (además de la hora) en cada mensaje del chat.

**Architecture:** Ambos cambios son puramente de frontend en `client/src/pages/Conversations.jsx`: una fila nueva en el bloque `profileSection` existente, y una función `formatDateTime` nueva usada en el renglón meta de cada burbuja de mensaje.

**Tech Stack:** React + Vite. Sin framework de testing en este repo — verificación con `npm run build` y prueba manual en el navegador.

## Global Constraints

- No modificar `formatTime` ni `formatDate` (las usa el resto de la UI).
- La fila de teléfono solo se muestra para `customer.channel === 'whatsapp'`.
- Sin reformateo de separadores en el teléfono — mostrar `+${customer.id}` tal cual.
- Spec de referencia: `docs/superpowers/specs/2026-08-11-telefono-fecha-mensajes-design.md`.

---

### Task 1: Teléfono en el panel de perfil

**Files:**
- Modify: `client/src/pages/Conversations.jsx` (bloque `profileSection`, ~línea 1280-1296)

**Interfaces:**
- Consumes: `customer.id`, `customer.channel` (ya provistos por `loadCustomer` / `GET /api/customers/:contactId`, sin cambios de backend).

- [ ] **Step 1: Agregar la fila de teléfono**

Modificar el bloque `profileSection` en `Conversations.jsx`:

Old:
```jsx
              <div className={styles.profileSection}>
                {customer.contactName && (
                  <div className={styles.profileRow}>
                    <span className={styles.profileKey}>Nombre</span>
                    <span className={styles.profileVal}>{customer.contactName}</span>
                  </div>
                )}
                {customer.tnEmail && (
```

New:
```jsx
              <div className={styles.profileSection}>
                {customer.contactName && (
                  <div className={styles.profileRow}>
                    <span className={styles.profileKey}>Nombre</span>
                    <span className={styles.profileVal}>{customer.contactName}</span>
                  </div>
                )}
                {customer.channel === 'whatsapp' && customer.id && (
                  <div className={styles.profileRow}>
                    <span className={styles.profileKey}>Teléfono</span>
                    <span className={styles.profileVal}>+{customer.id}</span>
                  </div>
                )}
                {customer.tnEmail && (
```

- [ ] **Step 2: Build para verificar sintaxis**

Run: `cd client && npm run build`
Expected: build exitoso, sin errores.

- [ ] **Step 3: Prueba manual en el navegador**

Con `npm run dev` corriendo (server + client), abrir un chat de WhatsApp en Conversaciones y confirmar que el panel de perfil muestra "Teléfono +549..." junto a Nombre/Email/Canal. Si el proyecto tiene algún chat de Instagram de prueba, confirmar que esa fila NO aparece ahí.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Conversations.jsx
git commit -m "feat(conversations): mostrar teléfono del cliente en el panel de perfil"
```

---

### Task 2: Fecha + hora en cada mensaje

**Files:**
- Modify: `client/src/pages/Conversations.jsx` (función `formatTime` ~línea 87, uso en burbuja de mensaje ~línea 217)

**Interfaces:**
- Consumes: `tsToDate(ts)` — helper ya existente (línea 67).
- Produces: `function formatDateTime(ts)` → `string`, usada solo en este archivo.

- [ ] **Step 1: Agregar `formatDateTime`**

Insertar inmediatamente después del cierre de `formatTime` (después de la línea 91, `}`):

```js
function formatDateTime(ts) {
  const d = tsToDate(ts);
  if (!d) return '';
  const datePart = d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  const timePart = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}
```

- [ ] **Step 2: Usarla en la burbuja de mensaje**

Modificar la línea que arma el meta del mensaje:

Old:
```jsx
        {msg.timestamp ? ` · ${formatTime(msg.timestamp)}` : ''}
```

New:
```jsx
        {msg.timestamp ? ` · ${formatDateTime(msg.timestamp)}` : ''}
```

- [ ] **Step 3: Build para verificar sintaxis**

Run: `cd client && npm run build`
Expected: build exitoso, sin errores.

- [ ] **Step 4: Prueba manual en el navegador**

Abrir cualquier chat con varios mensajes y confirmar que cada uno muestra `dd/mm hh:mm` en vez de solo la hora. Confirmar que otros usos de fecha/hora en la app (ej. "1er contacto" en el perfil, que usa `formatDate`) siguen igual que antes.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Conversations.jsx
git commit -m "feat(conversations): mostrar fecha y hora en cada mensaje del chat"
```
