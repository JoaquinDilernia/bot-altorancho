// Marcadores que el bot puede escribir en su respuesta y que se procesan del
// lado del servidor (invisibles para el cliente). Ver también
// parseEscalationMarker / parseCloseMarker / parseLabelMarkers en bot.service.js.

// [TAG:nombre]     -> agrega un tag EXISTENTE al contacto (doc de customers)
// [NEW_TAG:nombre] -> tag nuevo (mismo efecto de guardado; el split existe solo
//                     para poder loguear/distinguir como en los labels)
//
// Los tags de contacto persisten entre conversaciones y se usan para segmentar
// difusiones — distinto de los [LABEL:...], que clasifican la conversación.
export function parseCustomerTagMarkers(text) {
  const s = typeof text === 'string' ? text : '';
  const tags = [...s.matchAll(/\[TAG:\s*([^\]]+?)\s*\]/gi)].map(m => m[1].trim()).filter(Boolean);
  const newTags = [...s.matchAll(/\[NEW_TAG:\s*([^\]]+?)\s*\]/gi)].map(m => m[1].trim()).filter(Boolean);
  const cleanText = s.replace(/\[(NEW_)?TAG:\s*[^\]]+?\s*\]/gi, '').replace(/[ \t]{2,}/g, ' ').trim();
  return { tags, newTags, cleanText };
}
