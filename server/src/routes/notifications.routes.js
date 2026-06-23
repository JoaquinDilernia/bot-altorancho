import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js';
import {
  getPickupReadyOrders,
  sendBulkNotification,
  getNotificationHistory,
} from '../services/notifications.service.js';

const router = Router();
router.use(requireAuth);

// GET /api/notifications/pickup-ready — list of packed pickup orders from TiendaNube
router.get('/pickup-ready', async (req, res) => {
  try {
    const orders = await getPickupReadyOrders();
    res.json({ orders });
  } catch (err) {
    console.error('[notifications] pickup-ready error:', err.message);
    res.status(500).json({ error: err.response?.data?.message ?? err.message });
  }
});

// POST /api/notifications/send — send bulk template (admin only)
router.post('/send', requireAdmin, async (req, res) => {
  const { templateName, language, variables, recipients } = req.body ?? {};
  if (!templateName || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'templateName y recipients son requeridos' });
  }
  if (!Array.isArray(variables)) {
    return res.status(400).json({ error: 'variables debe ser un array' });
  }

  try {
    const results = await sendBulkNotification({
      templateName,
      language: language ?? 'es_AR',
      variables,
      recipients,
      sentBy: req.agent?.email,
    });
    res.json(results);
  } catch (err) {
    console.error('[notifications] send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications/history — last 20 sends
router.get('/history', async (req, res) => {
  try {
    const history = await getNotificationHistory();
    res.json({ history });
  } catch (err) {
    console.error('[notifications] history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
