import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cron from 'node-cron';

import webhookRoutes from './routes/webhook.routes.js';
import knowledgeRoutes from './routes/knowledge.routes.js';
import conversationRoutes from './routes/conversation.routes.js';
import configRoutes from './routes/config.routes.js';
import tiendaNubeRoutes from './routes/tiendanube.routes.js';
import customerRoutes from './routes/customer.routes.js';
import testRoutes from './routes/test.routes.js';
import authRoutes from './routes/auth.routes.js';
import labelRoutes from './routes/label.routes.js';
import statsRoutes from './routes/stats.routes.js';
import quickReplyRoutes from './routes/quickreply.routes.js';
import templateRoutes from './routes/template.routes.js';
import costsRoutes from './routes/costs.routes.js';
import { initFirebase } from './services/firebase.service.js';
import { seedAgentsIfNeeded } from './services/auth.service.js';
import { requireAuth } from './middleware/requireAuth.js';
import { closeInactiveConversations } from './services/inactivity.service.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Init Firebase
initFirebase();
seedAgentsIfNeeded().catch(err => console.error('[seed] Error seeding agents:', err));

// Inactivity cron: runs every hour, closes bot-handled conversations idle >24h
cron.schedule('0 * * * *', () => {
  closeInactiveConversations().catch(err => console.error('[cron] inactivity error:', err));
});

// Middleware
const allowedOrigins = [
  'http://localhost:5173',
  'https://gineza.techdi.com.ar',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS not allowed'));
  },
  credentials: true,
}));
app.use(morgan('dev'));

// Raw body para validación de firma Meta (debe ir antes del JSON parser)
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Routes (public)
app.use('/api/webhook', webhookRoutes);
app.use('/api/auth', authRoutes);

// Routes (protected)
app.use('/api/knowledge', requireAuth, knowledgeRoutes);
app.use('/api/conversations', requireAuth, conversationRoutes);
app.use('/api/config', requireAuth, configRoutes);
app.use('/api/tiendanube', requireAuth, tiendaNubeRoutes);
app.use('/api/customers', requireAuth, customerRoutes);
app.use('/api/test', requireAuth, testRoutes);
app.use('/api/labels', requireAuth, labelRoutes);
app.use('/api/stats', requireAuth, statsRoutes);
app.use('/api/quick-replies', requireAuth, quickReplyRoutes);
app.use('/api/templates', requireAuth, templateRoutes);
app.use('/api/costs', requireAuth, costsRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'bot-gineza' });
});

app.listen(PORT, () => {
  console.log(`[server] BOT-GINEZA corriendo en puerto ${PORT}`);
});

export default app;
