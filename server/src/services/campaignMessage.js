import { toMetaBody, resolveVars } from './templateVars.js';
import { toWaContactId } from './phone.js';

// Lógica pura de difusiones (validación del composer y armado del mensaje
// por destinatario) separada de campaign.service.js para poder testearla
// sin Firestore ni Meta.

const LINK_MODES = new Set(['button', 'text', 'none']);
const IMAGE_MAX_AGE_DAYS = 29; // el media id de Meta vence a los 30 días

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

export function validateComposer({ templateName, bodyText, linkMode, buttonText, targetUrl, publicBaseUrl }) {
  if (!/^[a-z0-9_]{1,512}$/.test(templateName ?? '')) {
    throw badRequest('El nombre técnico de la plantilla sólo puede tener minúsculas, números y _');
  }
  if (!LINK_MODES.has(linkMode)) throw badRequest('Modo de link inválido');
  const { body, order } = toMetaBody(bodyText);
  const usesLink = order.includes('link');
  if (linkMode === 'text' && !usesLink) {
    throw badRequest('Con el link "En el texto" tenés que insertar {{link}} en el mensaje');
  }
  if (linkMode !== 'text' && usesLink) {
    throw badRequest('Sacá {{link}} del texto, o elegí mostrar el link "En el texto"');
  }
  if (linkMode !== 'none' && !/^https?:\/\/\S+$/i.test(targetUrl?.trim() ?? '')) {
    throw badRequest('Cargá la URL destino del link (https://…)');
  }
  if (linkMode === 'button') {
    if (!publicBaseUrl) throw badRequest('El botón necesita PUBLIC_BASE_URL configurada en el servidor');
    const len = buttonText?.trim().length ?? 0;
    if (len < 1 || len > 25) throw badRequest('El texto del botón tiene que tener entre 1 y 25 caracteres');
  }
  return { body, order };
}

/** Comportamiento original de campaign.service.js para campañas creadas
    antes de las plantillas inline — no tocar el formato (p.ej. gastado sin "$"). */
export function legacyInterpolate(template, contact, link) {
  return (template ?? '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, contact.contactName || 'Cliente')
    .replace(/\{\{\s*link\s*\}\}/gi, link ?? '')
    .replace(/\{\{\s*pedidos\s*\}\}/gi, String(contact.tnOrderCount ?? 0))
    .replace(/\{\{\s*gastado\s*\}\}/gi, contact.tnTotalSpent != null ? String(Math.round(contact.tnTotalSpent)) : '0');
}

export function buildRecipientMessage({ campaign, contact, link, shortCode }) {
  const params = Array.isArray(campaign.varOrder)
    ? resolveVars(campaign.varOrder, contact, link)
    : (campaign.paramsTemplate ?? []).map(tpl => legacyInterpolate(tpl, contact, link));
  return {
    params,
    urlButtonParam: campaign.linkMode === 'button' ? shortCode : null,
    headerImageId: campaign.headerImage?.mediaId ?? null,
  };
}

export function isImageExpired(uploadedAt, now = new Date()) {
  if (!uploadedAt) return true;
  const d = typeof uploadedAt.toDate === 'function' ? uploadedAt.toDate() : new Date(uploadedAt);
  return now.getTime() - d.getTime() > IMAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

export function assertSendable(campaign, { publicBaseUrl, now = new Date() }) {
  if (campaign.templateHasImage) {
    if (!campaign.headerImage?.mediaId) throw badRequest('Esta plantilla lleva imagen: subila antes de enviar');
    if (isImageExpired(campaign.headerImage.uploadedAt, now)) {
      throw badRequest('La imagen venció en Meta (más de 29 días). Volvé a subir la imagen.');
    }
  }
  if (campaign.linkMode === 'button' && !publicBaseUrl) {
    throw badRequest('El botón necesita PUBLIC_BASE_URL configurada en el servidor');
  }
  if ((campaign.linkMode === 'button' || campaign.linkMode === 'text') && !campaign.targetUrl?.trim()) {
    throw badRequest('Esta plantilla lleva link: cargá la URL destino');
  }
}

const MAX_TEST_PHONES = 10;

/** Números para "Enviar prueba": texto libre (coma, punto y coma o uno por
    línea) o array. Se canonicalizan igual que el resto del sistema para que
    la prueba caiga en el mismo chat que usa el webhook. */
export function parseTestPhones(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]+/);
  const phones = [];
  for (const item of raw) {
    const text = String(item).trim();
    if (!text) continue;
    const id = toWaContactId(text);
    if (!id || !/^\d{10,15}$/.test(id)) throw badRequest(`Número inválido: ${text}`);
    if (!phones.includes(id)) phones.push(id);
  }
  if (phones.length === 0) throw badRequest('Cargá al menos un número de prueba');
  if (phones.length > MAX_TEST_PHONES) throw badRequest(`Máximo ${MAX_TEST_PHONES} números por prueba`);
  return phones;
}
