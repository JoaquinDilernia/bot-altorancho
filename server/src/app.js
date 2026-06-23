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
import departmentRoutes from './routes/department.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import { seedAgentsIfNeeded } from './services/auth.service.js';
import { seedDepartmentsIfNeeded } from './services/department.service.js';
import { requireAuth, requireAtLeastAtencionCliente } from './middleware/requireAuth.js';
import { closeInactiveConversations } from './services/inactivity.service.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Init Firebase
initFirebase();
seedAgentsIfNeeded().catch(err => console.error('[seed] Error seeding agents:', err));
seedDepartmentsIfNeeded().catch(err => console.error('[seed] Error seeding departments:', err));

// Inactivity cron: runs every hour, closes bot-handled conversations idle >24h
cron.schedule('0 * * * *', () => {
  closeInactiveConversations().catch(err => console.error('[cron] inactivity error:', err));
});

// Middleware
const allowedOrigins = [
  'http://localhost:5173',
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(s => s.trim()) : []),
].filter(Boolean);
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
// Operador can access: conversations (filtered), labels
// atencion_cliente + admin: all of the below
app.use('/api/conversations', requireAuth, conversationRoutes);
app.use('/api/labels', requireAuth, labelRoutes);

// Requires at least atencion_cliente
app.use('/api/knowledge', requireAtLeastAtencionCliente, knowledgeRoutes);
app.use('/api/config', requireAtLeastAtencionCliente, configRoutes);
app.use('/api/tiendanube', requireAtLeastAtencionCliente, tiendaNubeRoutes);
app.use('/api/customers', requireAtLeastAtencionCliente, customerRoutes);
app.use('/api/test', requireAtLeastAtencionCliente, testRoutes);
app.use('/api/stats', requireAtLeastAtencionCliente, statsRoutes);
app.use('/api/quick-replies', requireAtLeastAtencionCliente, quickReplyRoutes);
app.use('/api/templates', requireAtLeastAtencionCliente, templateRoutes);
app.use('/api/costs', requireAtLeastAtencionCliente, costsRoutes);
app.use('/api/departments', requireAtLeastAtencionCliente, departmentRoutes);
app.use('/api/notifications', requireAtLeastAtencionCliente, notificationsRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'bot-altorancho' });
});

app.listen(PORT, () => {
  console.log(`[server] BOT-ALTORANCHO corriendo en puerto ${PORT}`);
});

export default app;
