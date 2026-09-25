import { getDb } from './firebase.service.js';
import { fetchMetaTemplateStatuses, createMetaTemplate } from './meta.service.js';

const COLLECTION = 'bot-altorancho_whatsapp_templates';

/** Qué tiene la plantilla aprobada en Meta — así se detectan también las
    creadas a mano en Business Manager (no sólo las del panel). */
export function extractTemplateShape(components = []) {
  const list = Array.isArray(components) ? components : [];
  const header = list.find(c => c.type === 'HEADER');
  const buttons = list.find(c => c.type === 'BUTTONS')?.buttons ?? [];
  return {
    headerFormat: header?.format ?? null,
    hasUrlButton: buttons.some(b => b.type === 'URL'),
  };
}

export async function getAllTemplates() {
  const db = getDb();
  const snap = await db.collection(COLLECTION).orderBy('displayName').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function createTemplate({
  name, displayName, bodyText, language, category, params,
  header = null, button = null, bodyExamples = null, varOrder = null, linkMode = null, strict = false,
}) {
  const cleanName = name.trim();
  const cleanLanguage = language?.trim() || 'es_AR';
  const cleanParams = Array.isArray(params) ? params : [];

  // Submit to Meta for approval — errors are surfaced so the caller can inform the user
  let metaStatus = 'PENDING';
  let metaSubmitError = null;
  try {
    const result = await createMetaTemplate({
      name: cleanName,
      language: cleanLanguage,
      category: category || 'UTILITY',
      bodyText: bodyText.trim(),
      params: cleanParams,
      bodyExamples,
      header,
      button,
    });
    metaStatus = result.status ?? 'PENDING';
  } catch (err) {
    const detail = err.response?.data?.error?.error_user_msg ?? err.response?.data?.error?.message ?? err.message;
    console.error('[template] Error submitting to Meta:', detail);
    // Desde Difusiones no tiene sentido guardar una plantilla que Meta nunca
    // va a aprobar: se corta acá y el agente ve el motivo en el formulario.
    if (strict) {
      const e = new Error(`Meta rechazó la plantilla: ${detail}`);
      e.status = 502;
      throw e;
    }
    metaSubmitError = detail;
    // Don't throw — still save locally so agent knows the template exists
  }

  const db = getDb();
  const doc = await db.collection(COLLECTION).add({
    name: cleanName,
    displayName: displayName.trim(),
    bodyText: bodyText.trim(),
    language: cleanLanguage,
    category: category || 'UTILITY',
    params: cleanParams,
    headerFormat: header?.format ?? null,
    hasUrlButton: !!button,
    button: button ? { text: button.text, urlBase: button.urlBase } : null,
    varOrder: varOrder ?? null,
    linkMode: linkMode ?? null,
    metaStatus,
    metaSubmitError: metaSubmitError ?? null,
    rejectedReason: null,
    createdAt: new Date(),
  });
  const snap = await doc.get();
  return { id: snap.id, ...snap.data() };
}

function metaMatchFor(metaTemplates, name, language) {
  return metaTemplates.find(t => t.name === name && t.language === language)
    ?? metaTemplates.find(t => t.name === name);
}

function syncFields(metaMatch) {
  const fields = { metaStatus: metaMatch.status, rejectedReason: metaMatch.rejected_reason && metaMatch.rejected_reason !== 'NONE' ? metaMatch.rejected_reason : null };
  if (metaMatch.components) Object.assign(fields, extractTemplateShape(metaMatch.components));
  return fields;
}

export async function syncTemplateStatuses() {
  const metaTemplates = await fetchMetaTemplateStatuses();
  if (metaTemplates.length === 0) return;
  const db = getDb();
  const snap = await db.collection(COLLECTION).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) {
    const { name, language } = doc.data();
    const metaMatch = metaMatchFor(metaTemplates, name, language);
    if (metaMatch) batch.update(doc.ref, syncFields(metaMatch));
  }
  await batch.commit();
}

/** Sync de una sola plantilla — lo usa el polling de "Esperando aprobación". */
export async function syncTemplateStatus(name, language) {
  const metaTemplates = await fetchMetaTemplateStatuses();
  const metaMatch = metaMatchFor(metaTemplates, name, language);
  if (!metaMatch) return { status: null, rejectedReason: null };
  const fields = syncFields(metaMatch);
  const db = getDb();
  const snap = await db.collection(COLLECTION).where('name', '==', name).get();
  await Promise.all(snap.docs.map(d => d.ref.update(fields)));
  return { status: fields.metaStatus, rejectedReason: fields.rejectedReason };
}

export async function deleteTemplate(id) {
  const db = getDb();
  await db.collection(COLLECTION).doc(id).delete();
}
