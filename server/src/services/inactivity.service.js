import { getDb } from './firebase.service.js';
import { sendWhatsAppMessage, sendInstagramMessage } from './meta.service.js';
import { updateConversationStatus } from './conversation.service.js';

const DEFAULT_INACTIVE_HOURS = 24;
const DEFAULT_FAREWELL = 'Hola! Cerramos esta consulta por inactividad. Si necesitás ayuda en el futuro, escribinos cuando quieras 😊';

export async function closeInactiveConversations() {
  const db = getDb();

  const configDoc = await db.collection('bot-altorancho_config').doc('bot_config').get();
  const botConfig = configDoc.exists ? configDoc.data() : {};
  const inactiveHours = botConfig.inactiveCloseHours ?? DEFAULT_INACTIVE_HOURS;
  const farewellMsg = botConfig.inactiveFarewellMessage ?? DEFAULT_FAREWELL;

  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - inactiveHours);

  // Only close active bot conversations (not already archived, not in human mode)
  const snap = await db.collection('bot-altorancho_conversations')
    .where('status', '==', 'bot')
    .where('humanMode', '==', false)
    .get();

  const staleDocs = snap.docs.filter(doc => {
    const updatedAt = doc.data().updatedAt;
    return updatedAt && updatedAt.toDate() <= cutoff;
  });

  if (staleDocs.length === 0) return;

  console.log(`[inactivity] Cerrando ${staleDocs.length} conversaciones inactivas (>${inactiveHours}h)`);

  for (const doc of staleDocs) {
    const data = doc.data();
    const contactId = doc.id;

    try {
      if (data.channel === 'whatsapp') {
        await sendWhatsAppMessage(contactId, farewellMsg);
      } else if (data.channel === 'instagram') {
        await sendInstagramMessage(contactId, farewellMsg);
      }

      // Archive as bot_archived (distinct from agent-resolved)
      await updateConversationStatus(contactId, 'bot_archived');
      console.log(`[inactivity] Archivada ${contactId} (${data.channel}) → bot_archived`);
    } catch (err) {
      console.error(`[inactivity] Error cerrando ${contactId}:`, err.message);
    }
  }
}
