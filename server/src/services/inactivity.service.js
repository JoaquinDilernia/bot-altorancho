import { getDb } from './firebase.service.js';
import { sendWhatsAppMessage, sendInstagramMessage } from './meta.service.js';
import { updateConversationStatus, dispatchConversation } from './conversation.service.js';

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

  // Bot-only conversations (nunca llegaron a un humano) → se archivan como bot_archived
  const botSnap = await db.collection('bot-altorancho_conversations')
    .where('status', '==', 'bot')
    .where('humanMode', '==', false)
    .get();

  // Escaladas a un agente pero sin actividad hace rato → antes quedaban
  // abiertas para siempre salvo que alguien las cerrara a mano, inflando
  // "pendientes" en Estadísticas indefinidamente. Se resuelven solas igual.
  const escalatedSnap = await db.collection('bot-altorancho_conversations')
    .where('status', '==', 'escalated')
    .get();

  const isStale = doc => {
    const updatedAt = doc.data().updatedAt;
    return updatedAt && updatedAt.toDate() <= cutoff;
  };

  const staleBotDocs = botSnap.docs.filter(isStale);
  const staleEscalatedDocs = escalatedSnap.docs.filter(isStale);

  if (staleBotDocs.length === 0 && staleEscalatedDocs.length === 0) return;

  console.log(`[inactivity] Cerrando ${staleBotDocs.length} conversaciones de bot y ${staleEscalatedDocs.length} escaladas, inactivas hace >${inactiveHours}h`);

  // El envío del mensaje de despedida es best-effort — en un chat viejo lo
  // más probable es que la ventana de 24hs de WhatsApp ya haya expirado, y
  // si el cierre dependiera de que el envío funcione, las conversaciones
  // más viejas (justo las que hay que cerrar) nunca se cerrarían.
  async function sendFarewell(contactId, channel) {
    try {
      if (channel === 'whatsapp') await sendWhatsAppMessage(contactId, farewellMsg);
      else if (channel === 'instagram') await sendInstagramMessage(contactId, farewellMsg);
    } catch (err) {
      console.warn(`[inactivity] No se pudo avisar a ${contactId} (se cierra igual):`, err.response?.data?.error?.message ?? err.message);
    }
  }

  for (const doc of staleBotDocs) {
    const data = doc.data();
    const contactId = doc.id;
    await sendFarewell(contactId, data.channel);
    try {
      // Archive as bot_archived (distinct from agent-resolved)
      await updateConversationStatus(contactId, 'bot_archived');
      console.log(`[inactivity] Archivada ${contactId} (${data.channel}) → bot_archived`);
    } catch (err) {
      console.error(`[inactivity] Error archivando ${contactId}:`, err.message);
    }
  }

  for (const doc of staleEscalatedDocs) {
    const data = doc.data();
    const contactId = doc.id;
    await sendFarewell(contactId, data.channel);
    try {
      // Resolved (no bot_archived) — la atendió/la tenía asignada un humano.
      // dispatchConversation (no updateConversationStatus) apaga humanMode
      // junto con el status — si no, queda "resolved" con humanMode todavía
      // en true y la reapertura automática nunca se dispara cuando el
      // cliente vuelve a escribir.
      await dispatchConversation(contactId, { status: 'resolved', humanMode: false });
      console.log(`[inactivity] Resuelta por inactividad ${contactId} (${data.channel}, era de ${data.assignedTo ?? 'sin asignar'}) → resolved`);
    } catch (err) {
      console.error(`[inactivity] Error resolviendo escalada ${contactId}:`, err.message);
    }
  }
}
