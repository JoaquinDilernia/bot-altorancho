# Teléfono en perfil + fecha en mensajes

## Contexto

Dos ajustes chicos de UI pedidos por los agentes que usan la página de Conversaciones:
1. El panel de perfil del cliente (derecha) no muestra el número de teléfono.
2. Cada mensaje del chat solo muestra la hora (ej. "14:32"), sin fecha — dificulta ubicarse al scrollear conversaciones viejas.

## Diseño

### 1. Teléfono en el panel de perfil

En `client/src/pages/Conversations.jsx`, dentro del bloque `profileSection` que ya muestra Nombre/Email/Canal/1er contacto/ID Tienda Nube (~línea 1280), agregar una fila "Teléfono" después de "Nombre":

- Fuente del dato: `customer.id` (el `contactId` del documento de cliente, que para WhatsApp **es** el número de teléfono en formato `549...`).
- Se muestra solo si `customer.channel === 'whatsapp'` — en Instagram el `contactId` es un ID de la plataforma, no un teléfono.
- Formato: `+${customer.id}` (ej. `+5491123456789`). Sin reformateo de código de área/separadores — el dato crudo con `+` adelante es suficiente y evita bugs por longitudes variables de área code.

### 2. Fecha en cada mensaje

En el mismo archivo, la burbuja de mensaje (`~línea 217`) hoy renderiza `formatTime(msg.timestamp)` (solo hora). Se agrega una función nueva `formatDateTime(ts)` que devuelve fecha + hora juntas (ej. `11/08 14:32`), y se usa en ese renglón en lugar de `formatTime`.

`formatTime` y `formatDate` (funciones existentes) no se tocan — las usa el resto de la UI (ej. "1er contacto" en el perfil usa `formatDate` sola) y no forman parte de este cambio.

## Fuera de alcance

- Reformateo "bonito" del teléfono (separadores, código de país legible) — se deja para si surge la necesidad.
- Separador de día tipo WhatsApp (el usuario eligió mostrar fecha en cada mensaje, no un separador entre días).
