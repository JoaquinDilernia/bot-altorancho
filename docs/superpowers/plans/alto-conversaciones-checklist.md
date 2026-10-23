# Checklist — Conversaciones de Alto (diseño WhatsApp nativo)

Inventario hecho antes de tocar `client/src/pages/Conversations.jsx` (Task 5).
Cada ítem se verifica primero leyendo el código (dónde está implementado) y
después en Chrome contra producción con el usuario logueado.

Estado: `[ ]` pendiente · `código ✓` verificado leyendo el código · `navegador ✓` probado en Chrome.

## A. Funciones de Alto que existen hoy (no se puede perder ninguna)

### Lista
- [ ] A1. Lista de conversaciones con polling cada 10 s.
- [ ] A2. Buscar contacto (backend `/api/conversations/search`, desde 2 letras).
- [ ] A3. Filtro **Bot**.
- [ ] A4. Filtro **Mis casos** (asignadas a mí o a mi departamento).
- [ ] A5. Filtro **Crítico** (`critical`).
- [ ] A6. Filtro **Urgentes** (`urgent`).
- [ ] A7. Filtro **Esperando** (ordenado por espera). Ahora con la regla única del server (`pillFor` + `agents`).
- [ ] A8. Filtro **Notificaciones** (chats abiertos por plantilla sin respuesta: `notifiedAt` > `lastClientMessageAt`).
- [ ] A9. Filtro **Archivos/Archivados** (`/api/conversations/archived`).
- [ ] A10. Filtro **Equipos** (solo admin / atención al cliente) + selector de departamento.
- [ ] A11. Filtro por etiqueta.
- [ ] A12. Indicador de canal Instagram / WhatsApp en cada chat.
- [ ] A13. Color de demora (SLA): amarillo 15 min, naranja 30 min, rojo 60 min (`slaColor`) en el tiempo de espera.
- [ ] A14. Badges: crítico 🔴, urgente ⚡, insistente ⚠, "N msgs" sin respuesta, no leídos.
- [ ] A15. Badge del agente / departamento asignado (`AgentBadge`).
- [ ] A16. Chip de estado (`StatusChip`: Bot activo, Con agente, Archivado Bot, Cerrado, Urgente, En espera).
- [ ] A17. Etiquetas del chat en la fila.
- [ ] A18. Notificaciones del navegador (`useNotifications`).
- [ ] A19. Link directo `?open=<id>` (desde Estadísticas → Etiquetas).
- [ ] A20. Nueva conversación (＋): teléfono, nombre, plantilla aprobada, parámetros → `/api/conversations/start`.

### Chat
- [ ] A21. Encabezado: nombre, ⚡ si es urgente, canal, estado, agente asignado.
- [ ] A22. Intervenir / tomar conversación (`take_over` con mi id).
- [ ] A23. Devolver al bot (`to_bot`).
- [ ] A24. Derivar a agente (`assign_dept` con el email del agente).
- [ ] A25. Derivar a departamento (`assign_dept` con el id del departamento).
- [ ] A26. Marcar / quitar urgente.
- [ ] A27. Archivar (`bot_archive`) y reabrir (`to_bot`), también desde el aviso de archivada.
- [ ] A28. Agregar / quitar etiquetas.
- [ ] A29. Mensajes: imagen con lightbox + descargar; video; documento (abrir/descargar); audio con reproductor + transcribir.
- [ ] A30. Cita (`replyTo`) en el globo y responder citando (↩) en modo agente.
- [ ] A31. Nombre del agente en cada mensaje (`agentName`), "Cliente" y el bot.
- [ ] A32. Estado de entrega ✓ / ✓✓ / leído azul / ⏳.
- [ ] A33. Motivo de envío fallido (`msgError` → `META_ERROR_HINTS`) + botón reintentar.
- [ ] A34. Responder texto (Enter envía, Shift+Enter nueva línea) — WhatsApp **e Instagram** (el server elige el canal).
- [ ] A35. Respuestas rápidas: menú ⚡ y atajo `/atajo`.
- [ ] A36. Adjuntar archivo (imagen, video, audio, PDF, Word, Excel).
- [ ] A37. Ventana de 24 h: aviso a las 20 h; vencida (calculada o por error del server) bloquea texto y ofrece **plantilla aprobada** con parámetros y vista previa.
- [ ] A38. Banner de modo agente "Respondiendo como …".
- [ ] A39. Pie del bot "Alto está respondiendo automáticamente" + Tomar conversación.
- [ ] A40. Scroll: abre abajo, sigue abajo si estaba abajo, no arrastra la página.
- [ ] A41. Mobile: lista / chat / perfil deslizable, botón volver.

### Perfil
- [ ] A42. Sincronizar con Tienda Nube (↻ TN).
- [ ] A43. Datos: nombre, teléfono, email TN, canal, 1er contacto, ID Tienda Nube.
- [ ] A44. Pedidos de TiendaNube (número, total, fecha, estado, productos) o "Sin historial".
- [ ] A45. Resumen IA (generar / actualizar, métricas, fecha).
- [ ] A46. Notas del equipo (guardar).

## B. Funciones genéricas de TechDI que Alto no tiene (se agregan)

- [ ] B1. Reenviar mensajes: ↪ en el globo → modo selección → `ForwardModal` (buscar chat, hasta 10 destinos, solo WhatsApp, bloquea ventana 24 h cerrada, resultado por destino con cantidad enviada en fallas parciales; adjuntos de Instagram solo reenvían el texto).
- [ ] B2. Buscar dentro del chat con resaltado (sin tildes), contador "n de m", ↑ ↓, Enter / Shift+Enter / Esc.
- [ ] B3. `ConvAvatar`: avatar de color estable con iniciales y punto de canal (WhatsApp / Instagram) en lista, encabezado y perfil.
- [ ] B4. Subtítulo del contacto (`+teléfono · WhatsApp` / `usuario · Instagram`).
- [ ] B5. Adjuntos con ícono por tipo, nombre, tamaño y extensión; vista previa antes de enviar; pegar y arrastrar; texto opcional (se manda como mensaje aparte porque el server de Alto no recibe pie).
- [ ] B6. `isWaWindowClosed` en el modal de reenviar.
- [ ] B7. Grabar nota de voz con tiempo de grabación (00:12), cortar, cancelar, escuchar antes de enviar.
- [ ] B8. Avisos de traspaso en el chat ("X tomó la conversación" / "Alto volvió a responder") y separadores de día.
- [ ] B9. Firma del bot en el globo con `BotFace` + `useBrand().botName` ("Alto · bot"); nombre del agente en sus globos.
- [ ] B10. Píldora de estado arriba del chat (Responde Alto · Intervenir / Lo atiende X · Devolver a Alto / Esperando).
- [ ] B11. Chips de filtro con contador de "Esperando".
- [ ] B12. Chips de respuestas rápidas (3 a mano + "Todas ▾").
- [ ] B13. Emojis en el composer; composer que crece hasta 120 px; botón enviar ➤.
- [ ] B14. Hora dentro del globo + tooltip con fecha completa; stickers.
- [ ] B15. Perfil con avatar grande, "Cliente desde" y etiquetas.

## C. Reglas
- [ ] C1. Cero "TeDi" / "TechDI" en el cliente.
- [ ] C2. "Esperando" de la lista = server (`pillFor` con `agents`, departamentos como `areas`).
- [ ] C3. `npm test` y `npm run build` pasan.
