import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js';
import { getPickupOrders, sendBulkOrders, getNotificationHistory } from '../services/notifications.service.js';

const router = Router();
router.use(requireAuth);

// GET /api/notifications/pickup-orders — all pickup orders from TiendaNube (no status filter, client filters)
router.get('/pickup-orders', requireAdmin, async (req, res) => {
  try {
    const orders = await getPickupOrders();
    res.json({ orders });
  } catch (err) {
    console.error('[notifications] pickup-orders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/send-bulk — send template to selected orders
router.post('/send-bulk', requireAdmin, async (req, res) => {
  const { orders, templateName, languageCode, paramTemplate } = req.body ?? {};
  if (!orders?.length || !templateName || !languageCode) {
    return res.status(400).json({ error: 'orders, templateName y languageCode son requeridos' });
  }
  try {
    const result = await sendBulkOrders({
      orders,
      templateName,
      languageCode,
      paramTemplate: paramTemplate ?? [],
      sentBy: req.agent?.email,
    });
    res.json(result);
  } catch (err) {
    console.error('[notifications] send-bulk error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications/history
router.get('/history', async (req, res) => {
  try {
    const history = await getNotificationHistory();
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
