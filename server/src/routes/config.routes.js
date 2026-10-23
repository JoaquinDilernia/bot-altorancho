import { Router } from 'express';
import { getDb } from '../services/firebase.service.js';
import { requireAtLeastAtencionCliente } from '../middleware/requireAuth.js';

const router = Router();
const CONFIG_DOC = 'bot_config';

router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('bot-altorancho_config').doc(CONFIG_DOC).get();
    const config = doc.exists ? doc.data() : getDefaultConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Color de marca del panel: hex de 6 dígitos (o null para volver al default).
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

router.put('/', requireAtLeastAtencionCliente, async (req, res) => {
  try {
    if ('brandColor' in (req.body ?? {}) && req.body.brandColor !== null && !HEX_COLOR_RE.test(req.body.brandColor)) {
      return res.status(400).json({ error: 'brandColor tiene que ser un color hex tipo #343535' });
    }
    const db = getDb();
    await db.collection('bot-altorancho_config').doc(CONFIG_DOC).set(
      { ...req.body, updatedAt: new Date() },
      { merge: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Solo lo necesario para pintar el panel con la marca (sin el resto de la
// config). Lo usa cualquier rol, operadores incluidos.
const BRAND_DEFAULTS = { botName: 'Alto', brandColor: '#343535', businessName: 'Alto Rancho' };

export const brandRouter = Router();
brandRouter.get('/', async (req, res) => {
  try {
    const doc = await getDb().collection('bot-altorancho_config').doc(CONFIG_DOC).get();
    const c = doc.exists ? doc.data() : {};
    res.json({
      botName: c.botName || BRAND_DEFAULTS.botName,
      brandColor: HEX_COLOR_RE.test(c.brandColor ?? '') ? c.brandColor : BRAND_DEFAULTS.brandColor,
      businessName: c.businessName || BRAND_DEFAULTS.businessName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getDefaultConfig() {
  return {
    botName: 'Asistente',
    botPersonality: `Respondés de forma amigable, natural y cercana — como lo haría una persona real del equipo de Alto Rancho.\nUsás un tono cálido y profesional. Nunca robótico ni genérico.\nEscribís en español rioplatense (vos, che, etc.) con claridad.\nSi no sabés algo, lo decís honestamente y ofrecés derivar a una persona.\nNunca inventás información sobre precios, stock o pedidos — solo usás los datos que te den.`,
    welcomeMessage: '¡Hola! Soy el asistente de Alto Rancho 👋 ¿En qué puedo ayudarte?',
    offHoursMessage: 'Hola! En este momento estamos fuera de horario, pero te respondemos a la brevedad.',
    businessHours: {
      enabled: false,
      timezone: 'America/Argentina/Buenos_Aires',
      schedule: {
        monday: { open: '09:00', close: '18:00', active: true },
        tuesday: { open: '09:00', close: '18:00', active: true },
        wednesday: { open: '09:00', close: '18:00', active: true },
        thursday: { open: '09:00', close: '18:00', active: true },
        friday: { open: '09:00', close: '18:00', active: true },
        saturday: { open: '10:00', close: '14:00', active: true },
        sunday: { open: null, close: null, active: false },
      },
    },
    channels: { whatsapp: true, instagram: true },
    flowMode: 'freeform',
  };
}

export default router;
