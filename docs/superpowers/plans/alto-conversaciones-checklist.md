# Checklist — Conversaciones de Alto (diseño WhatsApp nativo)

Inventario hecho antes de tocar `client/src/pages/Conversations.jsx` (Task 5).
Cada ítem se verifica primero leyendo el código (dónde está implementado) y
después en Chrome contra producción con el usuario logueado.

Estado: `[ ]` pendiente · `código ✓` verificado leyendo el código · `navegador ✓` probado en Chrome.
Las líneas son de `client/src/pages/Conversations.jsx` en el commit 4035bac.

## A. Funciones de Alto que existen hoy (no se puede perder ninguna)

### Lista
- [ ] A1. Lista de conversaciones con polling cada 10 s. — código ✓ (L855) / navegador pendiente
- [ ] A2. Buscar contacto (backend `/api/conversations/search`, desde 2 letras). — código ✓ (L869) / navegador pendiente
- [ ] A3. Filtro **Bot**. — código ✓ (L1594) / navegador pendiente
- [ ] A4. Filtro **Mis casos** (asignadas a mí o a mi departamento). — código ✓ (L1598, `agent.department` como antes) / navegador pendiente
- [ ] A5. Filtro **Crítico** (`critical`). — código ✓ (FILTERS + L1602) / navegador pendiente
- [ ] A6. Filtro **Urgentes** (`urgent`). — código ✓ (FILTERS + L1605) / navegador pendiente
- [ ] A7. Filtro **Esperando** (ordenado por espera). Ahora con la regla única del server (`pillFor` + `agents`). — código ✓ (L1608, orden L1630, contador L1672) / navegador pendiente
- [ ] A8. Filtro **Notificaciones** (`notifiedAt` > `lastClientMessageAt`). — código ✓ (L1617) / navegador pendiente
- [ ] A9. Filtro **Archivados** (`/api/conversations/archived`). — código ✓ (L1126) / navegador pendiente
- [ ] A10. Filtro **Equipos** (solo admin / atención al cliente) + selector de departamento. — código ✓ (FILTERS minRole + L1613 + L1690) / navegador pendiente
- [ ] A11. Filtro por etiqueta. — código ✓ (chip-select "Etiqueta ▾" + L1626) / navegador pendiente
- [ ] A12. Indicador de canal Instagram / WhatsApp en cada chat. — código ✓ (punto de canal del avatar L69; `ChannelBadge` en el encabezado L1841) / navegador pendiente
- [ ] A13. Color de demora (SLA) 15/30/60 min (`slaColor`). — código ✓ (L165, aplicado en la lista L670) / navegador pendiente
- [ ] A14. Badges: crítico 🔴, urgente ⚡, insistente ⚠, "N msgs", no leídos. — código ✓ (L701–709) / navegador pendiente
- [ ] A15. Badge del agente / departamento asignado (`AgentBadge`). — código ✓ (lista L714 si la píldora no lo nombra ya; encabezado L1843) / navegador pendiente
- [ ] A16. Chip de estado (`StatusChip`). — código ✓ (encabezado del chat L1842; en la lista lo reemplaza la píldora de estado, que dice lo mismo con más detalle) / navegador pendiente
- [ ] A17. Etiquetas del chat en la fila. — código ✓ (L716: la primera + "+N", todas en el tooltip) / navegador pendiente
- [ ] A18. Notificaciones del navegador (`useNotifications`). — código ✓ (L834) / navegador pendiente
- [ ] A19. Link directo `?open=<id>`. — código ✓ (L734) / navegador pendiente
- [ ] A20. Nueva conversación (＋) → `/api/conversations/start`. — código ✓ (L1084, modal igual al de antes) / navegador pendiente

### Chat
- [ ] A21. Encabezado: nombre, ⚡ urgente, canal, estado, asignado. — código ✓ (L1751, L1841–1843) / navegador pendiente
- [ ] A22. Intervenir / tomar conversación (`take_over`). — código ✓ (píldora L1894, pie del bot L2358) / navegador pendiente
- [ ] A23. Devolver al bot (`to_bot`). — código ✓ (píldora L1911) / navegador pendiente
- [ ] A24. Derivar a agente (`assign_dept` con email). — código ✓ (L1771, grupo "Agentes") / navegador pendiente
- [ ] A25. Derivar a departamento (`assign_dept` con id). — código ✓ (L1771, grupo "Departamentos") / navegador pendiente
- [ ] A26. Marcar / quitar urgente. — código ✓ (L1798) / navegador pendiente
- [ ] A27. Archivar y reabrir (también desde el aviso de archivada). — código ✓ (L1820, L1810, L2012) / navegador pendiente
- [ ] A28. Agregar / quitar etiquetas. — código ✓ (L1863, L1846; también en el perfil L2415) / navegador pendiente
- [ ] A29. Imagen con lightbox + descargar; video; documento; audio + transcribir. — código ✓ (L398, L432, L439/L459, L424) / navegador pendiente
- [ ] A30. Cita en el globo y responder citando en modo agente. — código ✓ (L387, L1975) / navegador pendiente
- [ ] A31. Nombre del agente en cada mensaje (`agentName`) y el bot. — código ✓ (L383 `agentLabel` = `msg.agentName`; bot L381; los globos del cliente van sin firma, como en WhatsApp) / navegador pendiente
- [ ] A32. Estado de entrega ✓ / ✓✓ / leído / ⏳. — código ✓ (L476) / navegador pendiente
- [ ] A33. Motivo de envío fallido + reintentar. — código ✓ (L175 `META_ERROR_HINTS`, L476, L1974) / navegador pendiente
- [ ] A34. Responder texto (Enter / Shift+Enter), WhatsApp e Instagram. — código ✓ (L1257, mismo `/reply`; el server elige canal) / navegador pendiente
- [ ] A35. Respuestas rápidas: menú y atajo `/`. — código ✓ (L2238, L2298) / navegador pendiente
- [ ] A36. Adjuntar archivo (mismos tipos que antes). — código ✓ (L2291, `accept` igual al de antes; tope 16 MB del server) / navegador pendiente
- [ ] A37. Ventana de 24 h: aviso a las 20 h; vencida ofrece plantilla aprobada. — código ✓ (L2128, L2035, L1300) / navegador pendiente
- [ ] A38. Banner de modo agente. — código ✓ (L2107) / navegador pendiente
- [ ] A39. Pie del bot "Alto está respondiendo automáticamente". — código ✓ (L2355, con `useBrand().botName`) / navegador pendiente
- [ ] A40. Scroll: abre abajo, sigue abajo, no arrastra la página. — código ✓ (L939, L951, `scrollTo` sobre el contenedor) / navegador pendiente
- [ ] A41. Mobile: lista / chat / perfil deslizable, volver. — código ✓ (L1741 + clases `mobileHiddenPanel` / `profilePanelOpen`) / navegador pendiente

### Perfil
- [ ] A42. Sincronizar con Tienda Nube (↻ TN). — código ✓ (L2397) / navegador pendiente
- [ ] A43. Nombre, teléfono, email TN, canal, 1er contacto, ID TN. — código ✓ (L2436, L2452) / navegador pendiente
- [ ] A44. Pedidos de TiendaNube o "Sin historial". — código ✓ (L2460) / navegador pendiente
- [ ] A45. Resumen IA. — código ✓ (L2491) / navegador pendiente
- [ ] A46. Notas del equipo. — código ✓ (L2534) / navegador pendiente

## B. Funciones genéricas de TechDI que Alto no tenía (agregadas)

- [ ] B1. Reenviar (↪ → selección → `ForwardModal`): solo WhatsApp, bloquea ventana cerrada, cantidad enviada en fallas parciales, adjuntos de Instagram solo texto. — código ✓ (L510, L550, L627/L641, L586, L617) / navegador pendiente (probar solo con un chat de prueba del usuario)
- [ ] B2. Buscar en el chat con resaltado. — código ✓ (L1922, L467) / navegador pendiente
- [ ] B3. `ConvAvatar` en lista, encabezado y perfil. — código ✓ (L682, L1747, L2403) / navegador pendiente
- [ ] B4. Subtítulo del contacto. — código ✓ (L1753) / navegador pendiente
- [ ] B5. Adjuntos con ícono/nombre/tamaño, vista previa, pegar/arrastrar, texto opcional como mensaje aparte. — código ✓ (L439, L2147, L1422) / navegador pendiente
- [ ] B6. `isWaWindowClosed` en reenviar. — código ✓ (L627) / navegador pendiente
- [ ] B7. Nota de voz con tiempo de grabación. — código ✓ (L2193, botón L2327 solo si el navegador graba ogg/mp4 y el chat es WhatsApp) / navegador pendiente — **verificar que Meta acepte el audio grabado**
- [ ] B8. Avisos de traspaso y separadores de día. — código ✓ (L1958, L1961; nombre desde `agentName`) / navegador pendiente
- [ ] B9. Firma del bot con `BotFace` + `botName`. — código ✓ (L381) / navegador pendiente
- [ ] B10. Píldora de estado arriba del chat. — código ✓ (L1882) / navegador pendiente
- [ ] B11. Chips de filtro con contador de Esperando. — código ✓ (L1672) / navegador pendiente
- [ ] B12. Chips de respuestas rápidas. — código ✓ (L2220) / navegador pendiente
- [ ] B13. Emojis, composer que crece, enviar ➤. — código ✓ (L2271, L823) / navegador pendiente
- [ ] B14. Hora en el globo + fecha en tooltip; stickers. — código ✓ (L474, L435) / navegador pendiente
- [ ] B15. Perfil con avatar grande, "Cliente desde" y etiquetas. — código ✓ (L2402, L2413) / navegador pendiente

## C. Reglas
- [ ] C1. Cero "TeDi" / "TechDI" en el cliente. — código ✓ (grep en `Conversations.jsx` y `.module.css`) / navegador pendiente
- [ ] C2. "Esperando" de la lista = server (`pillFor` con `agents`, departamentos como `areas`). — código ✓ (`pillOf`, cerca de L832) / navegador pendiente
- [x] C3. `npm test` y `npm run build` pasan.
