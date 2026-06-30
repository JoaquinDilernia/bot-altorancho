import { Router } from 'express';
import admin from 'firebase-admin';
import { getDb } from '../services/firebase.service.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();
router.use(requireAuth);

function getPeriodStart(period) {
  const now = new Date();
  if (period === 'day') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // month
  const d = new Date(now);
  d.setDate(d.getDate() - 29);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDate(val) {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  return new Date(val);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function diffMin(a, b) {
  const da = toDate(a), db = toDate(b);
  if (!da || !db) return null;
  return (db - da) / 60000;
}

router.get('/', async (req, res) => {
  try {
    const period = req.query.period ?? 'week';
    const db = getDb();
    const start = getPeriodStart(period);
    const startTs = admin.firestore.Timestamp.fromDate(start);

    const [snap, agentsSnap, deptsSnap] = await Promise.all([
      db.collection('bot-altorancho_conversations').where('createdAt', '>=', startTs).get(),
      db.collection('bot-altorancho_agents').get(),
      db.collection('bot-altorancho_departments').get(),
    ]);

    const conversations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const agents = agentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const departments = deptsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const deptIds = new Set(departments.map(d => d.id));

    // --- Buckets ---
    const agentBuckets = { bot: { handled: 0, resolved: 0 } };
    for (const a of agents) agentBuckets[a.email] = { handled: 0, resolved: 0 };
    for (const dep of departments) agentBuckets[dep.id] = { handled: 0, resolved: 0 };

    const deptBuckets = {};
    for (const dep of departments) deptBuckets[dep.id] = { name: dep.name, handled: 0, resolved: 0, avgFirstResponseMin: null, _responseSamples: [] };

    const byStatus  = { bot: 0, urgent: 0, escalated: 0, resolved: 0 };
    const byChannel = { whatsapp: 0, instagram: 0 };
    const labelMap  = {};
    const dayMap    = {};

    let escalatedCount = 0;
    const firstResponseSamples = [];
    const resolutionSamples = [];

    for (const conv of conversations) {
      const status   = conv.status  ?? 'bot';
      const channel  = conv.channel ?? 'whatsapp';
      const assignee = conv.assignedTo ?? 'bot';

      if (status in byStatus)   byStatus[status]++;
      if (channel in byChannel) byChannel[channel]++;

      const bucket = agentBuckets[assignee] ?? agentBuckets['bot'];
      bucket.handled++;
      if (status === 'resolved' || status === 'bot_archived') bucket.resolved++;

      // Department breakdown
      if (deptIds.has(assignee) && deptBuckets[assignee]) {
        deptBuckets[assignee].handled++;
        if (status === 'resolved' || status === 'bot_archived') deptBuckets[assignee].resolved++;
      }

      // Escalation tracking
      if (conv.escalatedAt || status === 'escalated') {
        escalatedCount++;
        // First response time: escalatedAt → firstAgentResponseAt
        const respMin = diffMin(conv.escalatedAt, conv.firstAgentResponseAt);
        if (respMin !== null && respMin >= 0 && respMin < 24 * 60) {
          firstResponseSamples.push(respMin);
          if (deptIds.has(assignee)) deptBuckets[assignee]._responseSamples.push(respMin);
        }
      }

      // Resolution time: createdAt → resolvedAt
      const resMin = diffMin(conv.createdAt, conv.resolvedAt);
      if (resMin !== null && resMin >= 0 && resMin < 7 * 24 * 60) {
        resolutionSamples.push(resMin);
      }

      for (const lbl of conv.labels ?? []) {
        labelMap[lbl] = (labelMap[lbl] ?? 0) + 1;
      }

      const createdAt = toDate(conv.createdAt);
      if (createdAt) {
        const key = isoDate(createdAt);
        dayMap[key] = (dayMap[key] ?? 0) + 1;
      }
    }

    // --- Trend ---
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    const dailyTrend = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = isoDate(d);
      dailyTrend.push({ date: key, count: dayMap[key] ?? 0 });
    }

    // --- Derived metrics ---
    const total = conversations.length;
    const resolved = byStatus.resolved + (conversations.filter(c => c.status === 'bot_archived').length);
    const botHandledPct = total > 0 ? Math.round((agentBuckets['bot'].handled / total) * 100) : 0;
    const pending = conversations.filter(c => {
      const s = c.status ?? 'bot';
      return s !== 'resolved' && s !== 'bot_archived';
    }).length;

    const escalationRate = total > 0 ? Math.round((escalatedCount / total) * 100) : 0;

    const avg = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    const avgFirstResponseMin = avg(firstResponseSamples);
    const avgResolutionMin = avg(resolutionSamples);

    const labelCounts = Object.entries(labelMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const byAgent = [
      { id: 'bot', name: 'Bot (Asistente)', ...agentBuckets['bot'] },
      ...agents.map(a => ({
        id: a.id,
        name: a.name ?? a.email,
        ...(agentBuckets[a.email] ?? { handled: 0, resolved: 0 }),
      })),
      ...departments
        .filter(dep => agentBuckets[dep.id]?.handled > 0)
        .map(dep => ({
          id: dep.id,
          name: `${dep.name} (depto.)`,
          ...agentBuckets[dep.id],
        })),
    ];

    const byDepartment = departments
      .map(dep => ({
        id: dep.id,
        name: dep.name,
        handled: deptBuckets[dep.id]?.handled ?? 0,
        resolved: deptBuckets[dep.id]?.resolved ?? 0,
        avgFirstResponseMin: avg(deptBuckets[dep.id]?._responseSamples ?? []),
      }))
      .filter(d => d.handled > 0)
      .sort((a, b) => b.handled - a.handled);

    res.json({
      period,
      total,
      resolved,
      botResolutionRate: botHandledPct,
      pending,
      escalatedCount,
      escalationRate,
      avgFirstResponseMin,
      avgResolutionMin,
      byStatus,
      byChannel,
      byAgent,
      byDepartment,
      labelCounts,
      dailyTrend,
    });
  } catch (err) {
    console.error('[stats]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
