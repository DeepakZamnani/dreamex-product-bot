const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const leadsRoutes = require('./routes/leadsRoutes');
const messagesRoutes = require('./routes/messagesRoutes');
const adminDashboardRoutes = require('./routes/adminDashboardRoutes');
const agentsRoutes = require('./routes/agentsRoutes');
const chatRoutes = require('./routes/_chatRoutes');
const whatsappRoutes = require('./routes/_whatsappRoutes');
const activateLeadsRoutes = require('./routes/activateLeadsRoutes');
const brochureRoutes = require('./routes/_brochureRoutes');
const brochureGenerationsRoutes = require('./routes/brochureGenerationsRoutes');
const summaryRoutes = require('./routes/summaryRoutes');
const brokerRoutes   = require('./routes/brokerRoutes');
const propertyRoutes = require('./routes/propertyRoutes');
const { sendAdminAlert } = require('./controllers/leadsController');

const app = express();
const PORT = process.env.PORT || 5001;

const corsOptions = {
  origin: [
    'https://app.dreamexprop.com',
    'https://www.dreamexprop.com',
    'https://dreamexprop.com',
    'https://dreamex-product-bot.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-azmarq-secret', 'x-n8n-flow-webhook-auth'],
};

// Middleware
app.options(/.*/, cors(corsOptions)); // handle preflight for all routes
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Detect property site URL from incoming request host
app.use((req, _res, next) => {
  const host = req.get('host') || '';
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  req.propertySiteUrl = isLocal ? 'http://localhost:5173' : 'https://www.dreamexprop.com';
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/admin',adminDashboardRoutes)
app.use('/api/agents',agentsRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/chat/whatsapp', whatsappRoutes)
app.use('/api/activate-leads', activateLeadsRoutes)
app.use('/api/brochure', brochureRoutes)
app.use('/api/brochure-generations', brochureGenerationsRoutes)
app.use('/api/summary', summaryRoutes)
app.use('/api/broker',   brokerRoutes);
app.use('/api/property', propertyRoutes);
app.post('/api/admin-alert', sendAdminAlert)

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Backend server is running!' });
});


app.listen(PORT, () => {
  console.log(` Server is running on http://localhost:${PORT}`);
});