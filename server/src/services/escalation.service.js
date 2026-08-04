import { getDb } from './firebase.service.js';
import { sendWhatsAppMessage, sendInstagramMessage } from './meta.service.js';
import { appendMessage } from './conversation.service.js';
import { isWithinBusinessHours } from './bot.service.js';

const FOLLOWUP_HOURS = 2;
const FOLLOWUP_FLAG  = 'escalationFollowupSentAt';

export async function sendEscalationFollowups() {
  const db = getDb();

  const configDoc = await db.collection('bot-altorancho_config').doc('bot_config').get();
  const botConfig = configDoc.exists ? configDoc.data() : {};

  if (!isWithinBusinessHours(botConfig)) return; // solo durante horario laboral

  const cutoff = new Date(Date.now() - FOLLOWUP_HOURS * 60 * 60 * 1000);

  const snap = await db.collection('bot-altorancho_conversations')
    .where('humanMode', '==', true)
    .where('status', '==', 'escalated')
    .get();

  for (const doc of snap.docs) {
    const data = doc.data();
    const contactId = doc.id;

    // Ya enviamos el followup en esta sesión de escalación
    if (data[FOLLOWUP_FLAG]) continue;

    // Verificar que no hubo respuesta del agente (firstAgentResponseAt vacío)
    if (data.firstAgentResponseAt) continue;

    const escalatedAt = data.escalatedAt?.toDate?.() ?? null;
    if (!escalatedAt || escalatedAt > cutoff) continue;

    // Reclamar el envío de forma atómica ANTES de mandar nada — el check de
    // arriba (data[FOLLOWUP_FLAG]) lee un snapshot ya viejo para cuando
    // llegamos acá, así que si dos instancias corren en paralelo (ej: un
    // redeploy que solapa la instancia vieja con la nueva, o un servidor de
    // desarrollo apuntando por error a la misma base) las dos podían pasar
    // el check y mandar el mensaje duplicado — exactamente lo que pasó.
    const docRef = db.collection('bot-altorancho_conversations').doc(contactId);
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(docRef);
      if (fresh.data()?.[FOLLOWUP_FLAG]) return false;
      tx.update(docRef, { [FOLLOWUP_FLAG]: new Date() });
      return true;
    });
    if (!claimed) continue;

    const msg = '👋 Seguimos trabajando en tu consulta. Un agente te va a responder a la brevedad. ¡Gracias por tu paciencia!';

    try {
      await appendMessage(contactId, { role: 'assistant', content: msg });
      if (data.channel === 'whatsapp') await sendWhatsAppMessage(contactId, msg);
      else if (data.channel === 'instagram') await sendInstagramMessage(contactId, msg);

      console.log(`[escalation] Followup enviado a ${contactId}`);
    } catch (err) {
      console.error(`[escalation] Error enviando followup a ${contactId}:`, err.message);
    }
  }
}
