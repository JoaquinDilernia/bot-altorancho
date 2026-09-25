import { Router } from 'express';
import multer from 'multer';
import {
  listCampaigns,
  getCampaign,
  getCampaignSends,
  createCampaign,
  createCampaignWithTemplate,
  setCampaignImage,
  refreshTemplateStatus,
  deleteCampaign,
  sendCampaign,
  sendCampaignTest,
  computeCampaignAttribution,
  resolveSegment,
} from '../services/campaign.service.js';

const router = Router();
// 16MB como en conversation.routes.js: la foto se recomprime a ≤5MB después.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});
const publicBaseUrl = () => process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || null;

router.get('/', async (req, res) => {
  try {
    res.json({ campaigns: await listCampaigns() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/meta-info', (req, res) => {
  res.json({ canUseButton: !!publicBaseUrl() });
});

// Previsualización del segmento antes de crear/mandar la campaña — misma
// función que usa el envío real, así el conteo que ve el agente es exacto.
router.post('/preview-segment', async (req, res) => {
  try {
    const recipients = await resolveSegment(req.body.segment ?? {});
    const whatsappOnly = recipients.filter(c => c.channel === 'whatsapp');
    res.json({
      total: recipients.length,
      whatsappCount: whatsappOnly.length,
      sample: whatsappOnly.slice(0, 10).map(c => ({ contactId: c.contactId, contactName: c.contactName })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/with-template', upload.single('image'), async (req, res) => {
  try {
    let data;
    try { data = JSON.parse(req.body.data ?? '{}'); } catch { return res.status(400).json({ error: 'Datos inválidos' }); }
    const campaign = await createCampaignWithTemplate({
      data, imageFile: req.file ?? null, publicBaseUrl: publicBaseUrl(), createdBy: req.agent?.email ?? null,
    });
    res.status(201).json({ campaign });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, templateName, language, category, paramsTemplate, targetUrl, segment, varOrder, linkMode, templateHasImage } = req.body;
    const campaign = await createCampaign({
      name, templateName, language, category, paramsTemplate, targetUrl, segment, varOrder, linkMode, templateHasImage,
      createdBy: req.agent?.email ?? null,
    });
    res.status(201).json({ campaign });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
    const sends = await getCampaignSends(req.params.id);
    res.json({ campaign, sends });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/image', upload.single('image'), async (req, res) => {
  try {
    res.json({ campaign: await setCampaignImage(req.params.id, req.file ?? null) });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.get('/:id/template-status', async (req, res) => {
  try {
    res.json({ campaign: await refreshTemplateStatus(req.params.id) });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.post('/:id/send', async (req, res) => {
  try {
    // PUBLIC_BASE_URL: si no está seteada, la campaña igual se manda pero
    // sin link corto trackeable (ver campaign.service.js:sendCampaign).
    const result = await sendCampaign(req.params.id, publicBaseUrl());
    res.json(result);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.post('/:id/attribution', async (req, res) => {
  try {
    res.json({ campaign: await computeCampaignAttribution(req.params.id, { refreshClicked: true }) });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.post('/:id/test', async (req, res) => {
  try {
    const result = await sendCampaignTest(req.params.id, req.body.phones, {
      publicBaseUrl: publicBaseUrl(), sentBy: req.agent?.email ?? null,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteCampaign(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multer (ej: imagen > 16MB) u otro error no manejado en las rutas de arriba
// llega acá en vez de tirar el HTML por defecto de Express — sin esto el
// cliente rompe al hacer res.json() y el agente no sabe qué pasó.
router.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'La imagen supera los 16 MB' });
  res.status(err?.status ?? 500).json({ error: err?.message ?? 'Error interno' });
});

export default router;
