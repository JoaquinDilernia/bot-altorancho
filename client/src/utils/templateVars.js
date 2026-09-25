// Espejo (sólo para la UI) de server/src/services/templateVars.js — la
// resolución real por contacto la hace el backend al enviar.
export const TEMPLATE_VARS = [
  { key: 'nombre', label: 'Nombre completo', sample: 'Juan Pérez' },
  { key: 'primer_nombre', label: 'Primer nombre', sample: 'Juan' },
  { key: 'pedidos', label: 'Cantidad de pedidos', sample: '3' },
  { key: 'gastado', label: 'Total gastado', sample: '$ 45.000' },
  { key: 'ultimo_pedido', label: 'Fecha del último pedido', sample: '12/09/2026' },
  { key: 'link', label: 'Link de la promo', sample: 'https://altorancho.com.ar' },
];

const SAMPLES = Object.fromEntries(TEMPLATE_VARS.map(v => [v.key, v.sample]));

export function slugTemplateName(name, date = new Date()) {
  const base = (name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'difusion';
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `${base}_${mmdd}`;
}

export function renderPreview(text, contactName = null) {
  const full = contactName?.trim() || null;
  const values = { ...SAMPLES };
  if (full) {
    values.nombre = full;
    values.primer_nombre = full.split(/\s+/)[0];
  }
  return (text ?? '').replace(/\{\{\s*([^}]*?)\s*\}\}/g, (m, raw) => values[raw.toLowerCase()] ?? m);
}
