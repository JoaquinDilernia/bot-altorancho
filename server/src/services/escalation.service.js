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

    const msg = '👋 Seguimos trabajando en tu consulta. Un agente te va a responder a la brevedad. ¡Gracias por tu paciencia!';

    try {
      await appendMessage(contactId, { role: 'assistant', content: msg });
      if (data.channel === 'whatsapp') await sendWhatsAppMessage(contactId, msg);
      else if (data.channel === 'instagram') await sendInstagramMessage(contactId, msg);

      await db.collection('bot-altorancho_conversations').doc(contactId)
        .update({ [FOLLOWUP_FLAG]: new Date() });

      console.log(`[escalation] Followup enviado a ${contactId}`);
    } catch (err) {
      console.error(`[escalation] Error enviando followup a ${contactId}:`, err.message);
    }
  }
}
