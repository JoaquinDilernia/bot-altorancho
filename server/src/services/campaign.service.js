import crypto from 'crypto';
import admin from 'firebase-admin';
import { getDb } from './firebase.service.js';
import { listCustomers, enrichCustomerFromTiendaNube, invalidateCustomersCache } from './customer.service.js';
import { getOrCreateConversation, appendMessage, updateMessageStatus } from './conversation.service.js';
import { sendWhatsAppTemplate, uploadMetaMedia, uploadTemplateSampleImage, ensureWhatsAppImageSize, normalizeHeaderImage } from './meta.service.js';
import { createTemplate, syncTemplateStatus } from './template.service.js';
import { TEMPLATE_VARS, sampleValues } from './templateVars.js';
import { validateComposer, buildRecipientMessage, assertSendable, parseTestPhones } from './campaignMessage.js';
import { toWaContactId } from './phone.js';
import { addUtm, slugCampaign, attributeOrders, ATTRIBUTION_WINDOW_DAYS } from './attribution.js';

const CAMPAIGNS = 'bot-altorancho_campaigns';
const SENDS = 'bot-altorancho_campaign_sends';
const LINKS = 'bot-altorancho_short_links';

const SEND_THROTTLE_MS = 250; // ritmo prudente por defecto para no pegarle al rate-limit de Meta

function inc(n) { return admin.firestore.FieldValue.increment(n); }

// ─────────────────────────── Links cortos (clicks) ─────────────────────────

function makeShortCode() {
  return crypto.randomBytes(4).toString('hex'); // 8 chars, suficiente para el volumen de una difusión
}

async function createShortLink({ targetUrl, campaignId, contactId }) {
  const db = getDb();
  const code = makeShortCode();
  await db.collection(LINKS).doc(code).set({
    code, targetUrl, campaignId, contactId, createdAt: new Date(), clickCount: 0, firstClickedAt: null,
  });
  return code;
}

export async function resolveShortLink(code) {
  const db = getDb();
  const doc = await db.collection(LINKS).doc(code).get();
  return doc.exists ? doc.data() : null;
}

export async function registerClick(code) {
  const db = getDb();
  const linkRef = db.collection(LINKS).doc(code);
  const link = await linkRef.get();
  if (!link.exists) return null;
  const data = link.data();
  const isFirst = !data.firstClickedAt;
  await linkRef.update({
    clickCount: (data.clickCount ?? 0) + 1,
    ...(isFirst && { firstClickedAt: new Date() }),
  });
  // Sólo el primer click de cada destinatario cuenta para la estadística de
  // la campaña (evita que alguien reabriendo el link infle "clickeados").
  if (isFirst && data.campaignId && data.contactId) {
    await markSendClicked(data.campaignId, data.contactId);
  }
  return data;
}

// ─────────────────────────── Envíos (una fila por destinatario) ───────────

function sendDocId(campaignId, contactId) {
  return `${campaignId}__${contactId}`;
}

async function markSendClicked(campaignId, contactId) {
  const db = getDb();
  const ref = db.collection(SENDS).doc(sendDocId(campaignId, contactId));
  const doc = await ref.get();
  if (!doc.exists || doc.data().clickedAt) return;
  await ref.update({ clickedAt: new Date() });
  await db.collection(CAMPAIGNS).doc(campaignId).update({ 'stats.clicked': inc(1) });
}

/** Llamado desde el webhook de status de Meta (delivered/read/error), además
    de la actualización normal de la conversación — un waMsgId de campaña no
    está en ninguna conversación en particular indexable por contactId como
    las respuestas 1 a 1, así que acá sí hace falta una query por campo. */
export async function updateCampaignSendStatusByWaMsgId(waMsgId, status) {
  const db = getDb();
  const snap = await db.collection(SENDS).where('waMsgId', '==', waMsgId).limit(1).get();
  if (snap.empty) return;
  const ref = snap.docs[0].ref;
  const current = snap.docs[0].data();
  const RANK = { sent: 1, delivered: 2, read: 3 };
  if (status !== 'error' && (RANK[status] ?? 0) < (RANK[current.status] ?? 0)) return;
  const update = { status };
  if (status === 'delivered' && !current.deliveredAt) update.deliveredAt = new Date();
  if (status === 'read' && !current.readAt) update.readAt = new Date();
  await ref.update(update);
  if (['delivered', 'read', 'error'].includes(status) && current.status !== status) {
    const statKey = status === 'error' ? 'failed' : status;
    await db.collection(CAMPAIGNS).doc(current.campaignId).update({ [`stats.${statKey}`]: inc(1) });
  }
}

// ─────────────────────────── Campañas ──────────────────────────────────────

function mapCampaignDoc(doc) {
  return { id: doc.id, ...doc.data() };
}

export async function listCampaigns() {
  const db = getDb();
  const snap = await db.collection(CAMPAIGNS).orderBy('createdAt', 'desc').limit(100).get();
  return snap.docs.map(mapCampaignDoc);
}

export async function getCampaign(id) {
  const db = getDb();
  const doc = await db.collection(CAMPAIGNS).doc(id).get();
  return doc.exists ? mapCampaignDoc(doc) : null;
}

export async function getCampaignSends(campaignId) {
  const db = getDb();
  const snap = await db.collection(SENDS).where('campaignId', '==', campaignId).get();
  return snap.docs.map(d => d.data());
}

// Campos de segmento que se pasan tal cual a listCustomers (texto + canal +
// tags + todos los filtros de compras de Tienda Nube).
function segmentToFilters(segment = {}) {
  return {
    q: segment.q,
    channel: segment.channel,
    tags: segment.tags,
    hasOrders: segment.hasOrders,
    spentMin: segment.spentMin,
    spentMonths: segment.spentMonths,
    product: segment.product,
    productMonths: segment.productMonths,
    orderCountMin: segment.orderCountMin,
    lastOrderMaxDays: segment.lastOrderMaxDays,
    lastOrderMinDays: segment.lastOrderMinDays,
  };
}

/** Resuelve cuántos/quiénes matchean un segmento — usado tanto para la
    previsualización como para el envío real, así el conteo que ve el agente
    antes de mandar es exactamente la lista que va a recibir el mensaje. */
export async function resolveSegment(segment = {}) {
  return listCustomers(segmentToFilters(segment));
}

const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));

function buildCampaignDoc({ name, templateName, language, category, paramsTemplate, targetUrl, segment, createdBy,
  varOrder = null, linkMode = null, templateHasImage = false, headerImage = null, status = 'draft', templateStatus = 'APPROVED' }) {
  return {
    name: name.trim(),
    templateName: templateName.trim(),
    language: language || 'es_AR',
    category: category ?? null,
    paramsTemplate: Array.isArray(paramsTemplate) ? paramsTemplate : [],
    varOrder: Array.isArray(varOrder) ? varOrder : null,
    linkMode: linkMode ?? null,
    templateHasImage: !!templateHasImage,
    headerImage,
    templateStatus,
    templateRejectedReason: null,
    targetUrl: targetUrl?.trim() || null,
    segment: {
      q: segment?.q ?? null,
      channel: segment?.channel ?? null,
      tags: segment?.tags ?? [],
      hasOrders: !!segment?.hasOrders,
      spentMin: num(segment?.spentMin),
      spentMonths: num(segment?.spentMonths) ?? 12,
      product: segment?.product?.trim() || null,
      productMonths: num(segment?.productMonths) ?? 12,
      orderCountMin: num(segment?.orderCountMin),
      lastOrderMaxDays: num(segment?.lastOrderMaxDays),
      lastOrderMinDays: num(segment?.lastOrderMinDays),
    },
    status,
    createdBy: createdBy ?? null,
    createdAt: new Date(),
    sentAt: null,
    stats: { total: 0, sent: 0, failed: 0, delivered: 0, read: 0, clicked: 0 },
  };
}

export async function createCampaign(input) {
  if (!input.name?.trim() || !input.templateName?.trim()) {
    const e = new Error('name y templateName son requeridos');
    e.status = 400;
    throw e;
  }
  // Plantilla con botón/link en texto pero sin URL destino: manda "-" o un
  // botón sin parámetro a todos los destinatarios — Meta rechaza el envío.
  if ((input.linkMode === 'button' || input.linkMode === 'text') && !input.targetUrl?.trim()) {
    const e = new Error('Esta plantilla lleva link: cargá la URL destino');
    e.status = 400;
    throw e;
  }
  const doc = buildCampaignDoc(input);
  const ref = await getDb().collection(CAMPAIGNS).add(doc);
  return { id: ref.id, ...doc };
}

async function prepareImage(file) {
  if (!file) return null;
  const sized = await ensureWhatsAppImageSize(file.buffer, file.mimetype);
  return normalizeHeaderImage(sized.buffer, sized.mimeType);
}

/** Envuelve uploadTemplateSampleImage/uploadMetaMedia: si Meta rechaza la
    imagen, el error de axios (network-ish, sin .status) no le sirve de nada
    al agente — acá se convierte en un 502 con el motivo que dio Meta. */
async function uploadImageToMeta(uploadFn) {
  try {
    return await uploadFn();
  } catch (err) {
    const detail = err.response?.data?.error?.error_user_msg ?? err.response?.data?.error?.message ?? err.message;
    const e = new Error(`No se pudo subir la imagen a Meta: ${detail}`);
    e.status = 502;
    throw e;
  }
}

/** Difusión + plantilla nueva en un solo paso. Si Meta rechaza la plantilla
    no se crea nada (createTemplate strict) y el error vuelve al formulario. */
export async function createCampaignWithTemplate({ data, imageFile, publicBaseUrl, createdBy }) {
  const { name, templateName, category, bodyText, linkMode, buttonText, targetUrl, segment } = data ?? {};
  if (!name?.trim()) { const e = new Error('El nombre de la difusión es obligatorio'); e.status = 400; throw e; }
  const { body, order } = validateComposer({ templateName, bodyText, linkMode, buttonText, targetUrl, publicBaseUrl });

  const image = await prepareImage(imageFile);
  let handle = null;
  let mediaId = null;
  if (image) {
    handle = await uploadImageToMeta(() => uploadTemplateSampleImage(image.buffer, image.mimeType));
    mediaId = await uploadImageToMeta(() => uploadMetaMedia(image.buffer, image.mimeType));
  }

  const labels = Object.fromEntries(TEMPLATE_VARS.map(v => [v.key, v.label]));
  const tpl = await createTemplate({
    name: templateName,
    displayName: name,
    bodyText: body,
    language: 'es_AR',
    category: category === 'UTILITY' ? 'UTILITY' : 'MARKETING',
    params: order.map(k => labels[k]),
    bodyExamples: sampleValues(order),
    header: handle ? { format: 'IMAGE', handle } : null,
    button: linkMode === 'button' ? { text: buttonText.trim(), urlBase: publicBaseUrl } : null,
    varOrder: order,
    linkMode,
    strict: true,
  });

  const approved = tpl.metaStatus === 'APPROVED';
  return createCampaign({
    name, templateName, language: 'es_AR', category: tpl.category,
    paramsTemplate: [], varOrder: order, linkMode,
    targetUrl: linkMode === 'none' ? null : targetUrl,
    segment, createdBy,
    templateHasImage: !!handle,
    headerImage: mediaId ? { mediaId, uploadedAt: new Date() } : null,
    status: approved ? 'draft' : 'pending_template',
    templateStatus: tpl.metaStatus,
  });
}

export async function setCampaignImage(campaignId, imageFile) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) { const e = new Error('Campaña no encontrada'); e.status = 404; throw e; }
  if (!['draft', 'pending_template'].includes(campaign.status)) {
    const e = new Error('Sólo se puede cambiar la imagen antes de enviar'); e.status = 409; throw e;
  }
  if (!imageFile) { const e = new Error('No se recibió la imagen'); e.status = 400; throw e; }
  const image = await prepareImage(imageFile);
  const mediaId = await uploadImageToMeta(() => uploadMetaMedia(image.buffer, image.mimeType));
  const headerImage = { mediaId, uploadedAt: new Date() };
  await getDb().collection(CAMPAIGNS).doc(campaignId).update({ headerImage });
  return { ...campaign, headerImage };
}

export async function refreshTemplateStatus(campaignId) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) { const e = new Error('Campaña no encontrada'); e.status = 404; throw e; }
  if (campaign.status !== 'pending_template') return campaign;
  const { status, rejectedReason } = await syncTemplateStatus(campaign.templateName, campaign.language);
  const update = {};
  if (status === 'APPROVED') Object.assign(update, { status: 'draft', templateStatus: status });
  else if (status === 'REJECTED') Object.assign(update, { status: 'template_rejected', templateStatus: status, templateRejectedReason: rejectedReason ?? null });
  if (Object.keys(update).length === 0) return campaign;
  await getDb().collection(CAMPAIGNS).doc(campaignId).update(update);
  return { ...campaign, ...update };
}

export async function deleteCampaign(id) {
  const db = getDb();
  await db.collection(CAMPAIGNS).doc(id).delete();
  const snap = await db.collection(SENDS).where('campaignId', '==', id).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  if (!snap.empty) await batch.commit();
}

/**
 * Dispara el envío real — recorre el segmento, uno por uno, con el mismo
 * criterio que `sendBulkOrders()` en BOT-ALTORANCHO (la única difusión que
 * ya existía en el código): registra el mensaje en la conversación del
 * cliente (para que quede visible en el panel normal, con sus tildes), lo
 * manda por WhatsApp, y guarda un resultado por destinatario en `SENDS`.
 * No usa `await Promise.all` a propósito — un throttle secuencial es más
 * lento pero mucho más difícil que dispare el rate-limit de Meta que un
 * fan-out de cientos de requests en paralelo.
 */
export async function sendCampaign(campaignId, publicBaseUrl) {
  const db = getDb();
  const campaign = await getCampaign(campaignId);
  if (!campaign) { const e = new Error('Campaña no encontrada'); e.status = 404; throw e; }
  if (campaign.status !== 'draft') {
    const STATUS_MESSAGES = {
      pending_template: 'La plantilla todavía no fue aprobada por Meta',
      template_rejected: 'Meta rechazó la plantilla de esta difusión',
    };
    const e = new Error(STATUS_MESSAGES[campaign.status] ?? 'Esta campaña ya se envió');
    e.status = 409;
    throw e;
  }
  assertSendable(campaign, { publicBaseUrl });

  const trackedUrl = addUtm(campaign.targetUrl, { campaignSlug: slugCampaign(campaign.name) });
  const recipients = (await resolveSegment(campaign.segment)).filter(c => c.channel === 'whatsapp');

  await db.collection(CAMPAIGNS).doc(campaignId).update({
    status: 'sending',
    sentAt: new Date(),
    'stats.total': recipients.length,
  });

  // Se dispara en segundo plano — el request HTTP que crea/manda la campaña
  // no espera a que termine de mandarle a todos (puede ser una lista larga).
  (async () => {
    for (const contact of recipients) {
      // El id del cliente ya debería estar canónico, pero lo forzamos igual:
      // si la difusión crea la conversación con un formato distinto al que
      // usa el webhook entrante, la respuesta del cliente cae en otro chat.
      contact.contactId = toWaContactId(contact.contactId) ?? contact.contactId;
      const sendId = sendDocId(campaignId, contact.contactId);
      try {
        let shortCode = null;
        let link = trackedUrl;
        // linkMode null = campaña legacy: se comporta como antes (link si hay targetUrl)
        if (campaign.targetUrl && publicBaseUrl && campaign.linkMode !== 'none') {
          shortCode = await createShortLink({ targetUrl: trackedUrl, campaignId, contactId: contact.contactId });
          link = `${publicBaseUrl}/r/${shortCode}`;
        }
        const { params, urlButtonParam, headerImageId } = buildRecipientMessage({ campaign, contact, link, shortCode });

        await getOrCreateConversation(contact.contactId, 'whatsapp', contact.contactName);
        const msgId = crypto.randomUUID();
        const prefix = `[Difusión: ${campaign.templateName}]${headerImageId ? ' [Imagen]' : ''}`;
        const templateText = params.filter(Boolean).length > 0 ? `${prefix} ${params.join(' | ')}` : prefix;
        await appendMessage(contact.contactId, { role: 'admin', content: templateText, msgId, msgStatus: 'sending', sentBy: campaign.createdBy });

        let sendError = null;
        let waMsgId = null;
        try {
          waMsgId = await sendWhatsAppTemplate(contact.contactId, campaign.templateName, campaign.language, params, urlButtonParam, headerImageId);
        } catch (err) {
          sendError = err.response?.data?.error?.message ?? err.message;
        }
        await updateMessageStatus(contact.contactId, msgId, sendError ? 'error' : 'sent', waMsgId).catch(() => {});

        await db.collection(SENDS).doc(sendId).set({
          campaignId, contactId: contact.contactId, contactName: contact.contactName ?? null,
          waMsgId: waMsgId ?? null, shortCode,
          status: sendError ? 'error' : 'sent',
          error: sendError ?? null,
          sentAt: new Date(), deliveredAt: null, readAt: null, clickedAt: null,
        });
        await db.collection(CAMPAIGNS).doc(campaignId).update({
          [sendError ? 'stats.failed' : 'stats.sent']: inc(1),
        });
      } catch (err) {
        console.error(`[campaign] Error mandándole a ${contact.contactId}:`, err.message);
        await db.collection(SENDS).doc(sendId).set({
          campaignId, contactId: contact.contactId, contactName: contact.contactName ?? null,
          waMsgId: null, shortCode: null, status: 'error', error: err.message,
          sentAt: new Date(), deliveredAt: null, readAt: null, clickedAt: null,
        }, { merge: true });
        await db.collection(CAMPAIGNS).doc(campaignId).update({ 'stats.failed': inc(1) });
      }
      await new Promise(r => setTimeout(r, SEND_THROTTLE_MS));
    }
    await db.collection(CAMPAIGNS).doc(campaignId).update({ status: 'sent' });
  })().catch(err => console.error('[campaign] Error en el envío en background:', err));

  return { ok: true, total: recipients.length };
}

/**
 * "Enviar prueba": manda el mismo mensaje de la difusión a unos pocos números
 * antes del envío real. No toca stats, SENDS ni el estado de la campaña, y el
 * link corto se crea sin campaignId para que sus clicks no cuenten. Si el
 * número ya es contacto, sale con sus datos reales; si no, con los fallbacks.
 * Los números quedan guardados en la config para la próxima prueba.
 */
export async function sendCampaignTest(campaignId, phonesInput, { publicBaseUrl, sentBy }) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) { const e = new Error('Campaña no encontrada'); e.status = 404; throw e; }
  if (campaign.status !== 'draft') {
    const e = new Error('La prueba se puede mandar cuando la plantilla ya está aprobada y antes del envío real');
    e.status = 409;
    throw e;
  }
  assertSendable(campaign, { publicBaseUrl });
  const phones = parseTestPhones(phonesInput);

  const db = getDb();
  await db.collection('bot-altorancho_config').doc('bot_config').set({ campaignTestPhones: phones }, { merge: true });

  const trackedUrl = addUtm(campaign.targetUrl, { campaignSlug: slugCampaign(campaign.name), content: 'prueba' });
  const customers = await listCustomers({});
  const results = [];
  for (const phone of phones) {
    const contact = customers.find(c => toWaContactId(c.contactId) === phone) ?? { contactId: phone, contactName: null };
    let shortCode = null;
    let link = trackedUrl;
    if (campaign.targetUrl && publicBaseUrl && campaign.linkMode !== 'none') {
      shortCode = await createShortLink({ targetUrl: trackedUrl, campaignId: null, contactId: phone });
      link = `${publicBaseUrl}/r/${shortCode}`;
    }
    const { params, urlButtonParam, headerImageId } = buildRecipientMessage({ campaign, contact, link, shortCode });

    await getOrCreateConversation(phone, 'whatsapp', contact.contactName);
    const msgId = crypto.randomUUID();
    const prefix = `[Prueba difusión: ${campaign.templateName}]${headerImageId ? ' [Imagen]' : ''}`;
    const text = params.filter(Boolean).length > 0 ? `${prefix} ${params.join(' | ')}` : prefix;
    await appendMessage(phone, { role: 'admin', content: text, msgId, msgStatus: 'sending', sentBy });

    let error = null;
    let waMsgId = null;
    try {
      waMsgId = await sendWhatsAppTemplate(phone, campaign.templateName, campaign.language, params, urlButtonParam, headerImageId);
    } catch (err) {
      error = err.response?.data?.error?.error_user_msg ?? err.response?.data?.error?.message ?? err.message;
    }
    await updateMessageStatus(phone, msgId, error ? 'error' : 'sent', waMsgId).catch(() => {});
    results.push({ phone, ok: !error, error });
    await new Promise(r => setTimeout(r, SEND_THROTTLE_MS));
  }
  return { results };
}

// ─────────────────────────── Ventas atribuidas ─────────────────────────────

const MAX_STORED_BUYERS = 300;

/**
 * Cruza los destinatarios con sus pedidos de Tienda Nube (ver attribution.js)
 * y guarda el resultado en la campaña. Los pedidos se actualizan de noche;
 * con `refreshClicked` se re-consultan en TN los que tocaron el link (pocos,
 * y los que más probablemente compraron) para no esperar al sync nocturno.
 */
export async function computeCampaignAttribution(campaignId, { refreshClicked = false } = {}) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) { const e = new Error('Campaña no encontrada'); e.status = 404; throw e; }
  if (!['sending', 'sent'].includes(campaign.status)) {
    const e = new Error('Las ventas se calculan cuando la difusión ya se envió'); e.status = 409; throw e;
  }
  const sends = await getCampaignSends(campaignId);

  if (refreshClicked) {
    for (const s of sends.filter(x => x.clickedAt)) {
      await enrichCustomerFromTiendaNube(s.contactId, true)
        .catch(err => console.error(`[attribution] No se pudo refrescar ${s.contactId}:`, err.message));
    }
    invalidateCustomersCache();
  }

  const customers = await listCustomers({});
  const customersById = new Map();
  for (const c of customers) customersById.set(toWaContactId(c.contactId) ?? c.contactId, c);

  const { buyers, summary } = attributeOrders({ sends, customersById, windowDays: ATTRIBUTION_WINDOW_DAYS });
  const attribution = {
    ...summary,
    windowDays: ATTRIBUTION_WINDOW_DAYS,
    computedAt: new Date(),
    buyersList: buyers.slice(0, MAX_STORED_BUYERS),
  };
  await getDb().collection(CAMPAIGNS).doc(campaignId).update({ attribution });
  return { ...campaign, attribution };
}

/** Cron nocturno: recalcula las difusiones enviadas dentro de la ventana (+1 día de margen). */
export async function refreshRecentAttributions() {
  const since = new Date(Date.now() - (ATTRIBUTION_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
  const snap = await getDb().collection(CAMPAIGNS).where('sentAt', '>=', since).get();
  for (const doc of snap.docs) {
    if (!['sending', 'sent'].includes(doc.data().status)) continue;
    await computeCampaignAttribution(doc.id)
      .catch(err => console.error(`[attribution] Error en la campaña ${doc.id}:`, err.message));
  }
}
