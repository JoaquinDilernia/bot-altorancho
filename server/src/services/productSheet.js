// Ficha de producto y elección de SKU para las herramientas del bot
// (buscar_productos / consultar_stock_locales). Funciones puras, sin red.

const MAX_DESC_CHARS = 1500;

export function productName(p) {
  const n = p?.name;
  return typeof n === 'string' ? n : (n?.es ?? n?.en ?? Object.values(n ?? {})[0] ?? 'Producto');
}

// TiendaNube guarda las tildes como entidades (&aacute;, &ntilde;…).
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', deg: '°', times: '×', ordm: 'º', ordf: 'ª',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  iexcl: '¡', iquest: '¿', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

function decodeEntity(whole, body) {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  }
  return NAMED_ENTITIES[body] ?? whole;
}

// Quita el <link> de Google Fonts y las etiquetas HTML que TiendaNube guarda
// en la descripción del producto, dejando texto plano legible para el prompt.
export function stripProductDescriptionHtml(html) {
  return String(html ?? '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, decodeEntity)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Descripción (material, medidas, aclaraciones) + medidas cargadas en la
 * variante. null si el producto no tiene ninguna de las dos.
 */
export function formatProductSheet(p, { maxDesc = MAX_DESC_CHARS } = {}) {
  const rawDesc = p?.description?.es ?? p?.description?.en ?? Object.values(p?.description ?? {})[0] ?? '';
  let desc = rawDesc ? stripProductDescriptionHtml(rawDesc) : '';
  if (desc.length > maxDesc) desc = `${desc.slice(0, maxDesc).trimEnd()}…`;

  // Las medidas cargadas en la variante suelen ser las del paquete (ej: silla
  // Menorca 92x55x70 vs. 54 de ancho en la descripción): si la descripción
  // ya trae medidas, solo se usan esas para no confundir al bot.
  const descHasMeasures = /\d\s?(cm|mm|m)\b|medidas/i.test(desc);
  const v = p?.variants?.[0];
  const hasDims = !descHasMeasures && v && [v.width, v.height, v.depth].some(x => x != null && Number(x) > 0);
  const dims = hasDims
    ? `Medidas del sistema (pueden diferir levemente de la descripción): Ancho ${v.width ?? '?'}cm x Alto ${v.height ?? '?'}cm x Profundidad ${v.depth ?? '?'}cm`
    : null;

  if (!desc && !dims) return null;
  return [desc && `Descripción: ${desc}`, dims].filter(Boolean).join('\n');
}

/**
 * SKU para consultar Odoo: el de la variante pedida si existe, si no el de la
 * primera variante con SKU. null si el producto no tiene ninguno.
 */
export function pickVariantSku(p, varianteId = null) {
  const variants = p?.variants ?? [];
  if (varianteId != null) {
    const chosen = variants.find(v => String(v.id) === String(varianteId));
    if (chosen?.sku) return { sku: chosen.sku, variant: chosen };
  }
  const withSku = variants.find(v => v.sku);
  return withSku ? { sku: withSku.sku, variant: withSku } : null;
}

export function variantLabel(v) {
  return (v?.values ?? []).map(val => val?.es ?? val?.en ?? Object.values(val ?? {})[0]).filter(Boolean).join(' / ') || null;
}
