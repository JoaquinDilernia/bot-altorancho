# Panel "WhatsApp nativo" en ALTORANCHO

Fecha: 2026-10-23 · Repo: BOT-ALTORANCHO (`client/` + `server/`) · Referencia: el rediseño ya hecho en BOT-TECHDI (spec `BOT-TECHDI/docs/superpowers/specs/2026-10-20-panel-whatsapp-nativo-design.md`, código en `BOT-TECHDI/client/src` y `BOT-TECHDI/server/src`, commits 60ecf21…1b526df).

## Por qué

El rediseño "WhatsApp nativo" se hizo primero en TechDI como laboratorio y salió bien: Conversaciones, Dashboard, Estadísticas y el menú mejoraron mucho. Ahora se lleva a todos los bots, empezando por ALTORANCHO, que es el más grande y el que más usa el cliente. Alto Rancho tiene muchas funciones propias (Instagram, SimpliRoute, recordatorios de pago, difusiones con costo, departamentos, carritos de TiendaNube) y **todo tiene que seguir funcionando**, ahora con el diseño nuevo.

Lo que se aprenda acá sirve de receta para los bots siguientes (PMC, ENTRENO, Selvaggio, TRANSCOLECTIVO, BASE).

## Objetivos

- El panel de Alto se ve y se usa como el de TechDI: mismo menú agrupado, mismo Conversaciones estilo WhatsApp, mismo Dashboard ("Inicio") y mismas Estadísticas nuevas.
- **Identidad de Alto Rancho:**
  - Paleta actual de Alto: carbón `#343535` como color de marca, fondo beige `#f5f2ee`, superficies y bordes cálidos de `global.css`.
  - Tipografía **Poppins** (no se cambia a Figtree como en TechDI).
  - El bot se llama **"Alto"**: firma los mensajes del bot ("Alto · bot"), habla en el globo del Dashboard y en la tarjeta estrella de Estadísticas ("Resolvió Alto solo X%").
- **Conversaciones** suma las funciones genéricas que TechDI tiene y Alto no: reenviar mensajes, buscar dentro del chat (con resaltado), adjuntos con tipo y tamaño, avatar de contacto, aviso de ventana de 24 h cerrada, avisos de traspaso bot ↔ agente, y todo lo demás que TechDI tenga en Conversaciones que sea genérico.
- **Dashboard y Estadísticas** nuevos de TechDI (globo del bot, "Te esperan", "Pasando ahora", métrica estrella, variaciones contra el período anterior, día vs noche, animaciones solo en la primera carga) **más** las secciones propias de Alto.
- **Menú** agrupado de TechDI (Dashboard primero, desplegables que arrancan cerrados, contador de "esperando", colapsable), con las pantallas de Alto ubicadas en los grupos.

## No objetivos

- Rediseñar a fondo las pantallas propias de Alto (SimpliRoute, Pagos pendientes, Notificaciones, Departamentos, Difusiones, Contactos, Plantillas, Base de conocimiento, Config, etc.). Solo toman el estilo nuevo (tokens, tarjetas, botones, tipografía) y siguen haciendo exactamente lo mismo.
- Funciones de negocio exclusivas de TechDI: Proyectos, Tickets, Áreas como pantalla (Alto usa Departamentos).
- Cambiar la lógica del bot.
- Llevarlo a los otros bots (trabajo aparte, después).
- Modo oscuro.

## Anti-objetivos (sería un fracaso aunque funcione)

- Se pierde cualquier función que Alto tiene hoy. En Conversaciones: chats de Instagram, color de demora (SLA), badge del agente, chip de estado, pedidos de TiendaNube en la conversación, etiquetas, filtros, derivar a departamento/agente, urgente, archivar, intervenir/devolver al bot, respuestas rápidas, plantillas fuera de 24 h, audio, adjuntos, notas, resumen, motivo de envío fallido, nueva conversación. En Estadísticas: por canal (WhatsApp/Instagram), por departamento, por agente, por estado, etiquetas, carritos del bot.
- El panel de Alto queda verde-TechDI o con la marca/nombre de TechDI ("TeDi", "TechDI") en algún lado.
- Se rompe algo en producción a mitad de camino: el backend se deploya solo al pushear a main, así que los cambios de servidor tienen que ser compatibles con el panel viejo que sigue online hasta que se sube el dist nuevo.

## Restricciones

- Stack igual que TechDI: React 18 + Vite + CSS Modules, sin librerías nuevas pesadas. Backend Node ESM + Express + Firestore (colecciones con prefijo `bot-altorancho_`).
- Backend en Railway (proyecto `talented-emotion`) con auto-deploy al pushear a main. Frontend: el usuario sube `client/dist` a Hostinger a mano.
- Mobile tiene que seguir andando.
- `prefers-reduced-motion` respetado.
- Hay archivos sueltos sin trackear en el repo ("Copia en conflicto…", `server/_tmp-*.mjs`, `docs/ig-app-review/`): no se tocan ni se commitean.

## Lo que se decidió (con el usuario)

1. Mismo diseño que TechDI en todo el panel, con paleta de Alto, Poppins y bot "Alto".
2. Conversaciones: diseño nuevo + funciones genéricas de TechDI que Alto no tiene, sin perder nada propio de Alto.
3. Pantallas propias de Alto: solo estilo nuevo, misma funcionalidad.
4. Dashboard, Estadísticas y menú nuevos de TechDI.

## Datos (backend)

Lo mismo que necesitó TechDI, adaptado a Alto:

- `GET /api/stats`: bloque `previous` (mismo rango anterior de igual duración, por días) y `byBusinessHours: { inside, outside }` según el horario de `bot_config` en hora Argentina. Sin sacar los campos que usa Alto hoy (`byChannel`, `byDepartment`/equivalente, `byAgent`, por estado, etiquetas).
- Regla única de "esperando" y endpoints livianos que usa el panel nuevo (`/api/stats/waiting` para el contador del menú, y lo que use el Dashboard de TechDI).
- `bot_config.brandColor` (por defecto el carbón de Alto) y `bot_config.botName` = "Alto", con `GET /api/config/brand` abierto a todos los roles, editable en Config.
- `POST /api/conversations/forward` para reenviar.
- Todo endpoint nuevo es aditivo: el panel viejo sigue funcionando con el backend nuevo.

## Lo que queda a criterio de quien construye

- Cómo traer el código de TechDI: copiar componentes/páginas y re-agregar lo de Alto, o aplicar el diseño sobre los archivos de Alto. Lo que sea más seguro para no perder funciones.
- Cómo mapear la paleta de Alto a los tokens nuevos (`--brand`, `--brand-soft`, `--brand-ink`, estados). Los globos salientes verdes de WhatsApp, el fondo de chat con dibujitos y los avisos amarillos se mantienen porque son la identidad del producto.
- Agrupación exacta del menú.
- Partición de archivos, íconos, textos de estados vacíos.

## Decisiones que tomé yo (para revisar)

- **Trabajo en una rama** (`panel-whatsapp-nativo`) y se mergea a main por partes cuando cada parte esté probada en Chrome contra el backend de producción. Los cambios de backend (aditivos) pueden ir antes.
- **Color de marca de Alto = `#343535`.** Con un color tan oscuro, `--brand-soft` sale gris claro y la cara del bot es carbón: queda sobrio, acorde a la marca. Los estados (esperando rojo, agente violeta, resuelta verde, etiquetas ámbar) quedan iguales que TechDI.
- **Menú de Alto** (propuesta):
  - Sin grupo: Dashboard, Conversaciones, Estadísticas.
  - **Clientes:** Contactos, Difusiones, Pagos pendientes.
  - **Operación:** SimpliRoute, Notificaciones.
  - **Equipo:** Usuarios, Departamentos.
  - **Configuración:** Knowledge Base, Etiquetas, Resp. rápidas, Plantillas, Simulador, Configuración, Costos.
  - Se respetan los `minRole` actuales de cada ítem; la pantalla de entrada por rol es la de TechDI (`homePath`).
- **Reenviar** solo a chats de WhatsApp (Instagram tiene otras reglas de envío). Si TechDI ya lo resuelve distinto, se sigue a TechDI.
- **Orden:** backend aditivo → tokens/tipografía/menú → Conversaciones → Dashboard → Estadísticas → pasada de estilo a pantallas propias → verificación completa en Chrome.
- **"Esperando" en Alto:** cuenta WhatsApp **e Instagram**, y una conversación marcada urgente que espera agente cuenta como esperando. Una sola función en el backend define la regla y la usan el contador del menú, "Te esperan" del Dashboard, el filtro de la lista y `awaitingAgent` de Estadísticas, para que nunca den distinto. El color de demora (SLA) de la lista se mantiene como está en Alto, encima del estado.
- **Secciones de Estadísticas de Alto:** se quedan todas (por canal, por departamento, por agente, por estado, etiquetas, carritos del bot). Se reacomodan dentro del layout nuevo de TechDI con el estilo nuevo: por canal en la dona, por departamento en barras horizontales (donde TechDI pone "por área"), por agente en el ranking, etiquetas en chips, y "por estado" y "carritos del bot" como secciones propias al final. Ningún número que hoy se ve deja de verse.
- **Cuando Conversaciones de TechDI y Alto hacen lo mismo distinto, gana el comportamiento de Alto** (pedidos de TiendaNube, plantillas fuera de 24 h, notas, resumen, nueva conversación, Instagram); TechDI aporta el diseño y las funciones que Alto no tiene.
- **Reenviar:** se puede reenviar desde cualquier chat (también desde Instagram) hacia chats de **WhatsApp**; los destinos con la ventana de 24 h cerrada se bloquean igual que en TechDI.
- **Nombre y color del bot:** se aplican en vivo como en TechDI (`BrandContext`), editables en Config. Si el texto sobre `--brand` carbón no se lee, se ajusta el derivado, no el color. Hay que revisar que no quede "TeDi"/"TechDI" fijo en ningún texto, y que el horario de `bot_config` de Alto tenga la forma que espera `byBusinessHours` (si no, se adapta el cálculo, no los datos).
- **Deploy:** el backend aditivo se puede mergear a main antes (no rompe el panel viejo). El frontend se prueba local apuntando al backend de producción (no hay staging) y se mergea y se sube el dist **una sola vez al final**, cuando todo esté verificado.
