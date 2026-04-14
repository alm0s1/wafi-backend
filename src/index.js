require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const db = require('./config/database');
const redis = require('./config/redis');
const firebase = require('./config/firebase');
const { startRenewalCron } = require('./jobs/renewalCron');

const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscription');
const cardsRoutes = require('./routes/cards');
const stampsRoutes = require('./routes/stamps');
const businessRoutes = require('./routes/business');
const walletRoutes = require('./routes/wallet');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ---------------------------------------------------------------------------
// Request logging (development only)
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV === 'development') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', async (_req, res) => {
  const checks = { status: 'ok', timestamp: new Date().toISOString() };

  try {
    await db.query('SELECT 1');
    checks.database = 'connected';
  } catch {
    checks.database = 'disconnected';
    checks.status = 'degraded';
  }

  try {
    await redis.client.ping();
    checks.redis = 'connected';
  } catch {
    checks.redis = 'disconnected';
    checks.status = 'degraded';
  }

  const statusCode = checks.status === 'ok' ? 200 : 503;
  return res.status(statusCode).json(checks);
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/cards', cardsRoutes);
app.use('/api/stamps', stampsRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/cards', walletRoutes);   // wallet-status & wallet-pass under /api/cards/:id/
app.use('/api/wallet', walletRoutes);  // public download under /api/wallet/download/

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  try {
    // Connect to PostgreSQL
    await db.connect();

    // Connect to Redis
    await redis.connect();

    // Initialize Firebase Admin SDK
    firebase.initialize();

    // Start the daily renewal cron job
    startRenewalCron();

    // Start the HTTP server
    app.listen(PORT, () => {
      console.log(`Wafi backend running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down gracefully');
  try {
    await redis.client.quit();
    await db.pool.end();
  } catch (err) {
    console.error('Error during graceful shutdown:', err.message);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received — shutting down');
  try {
    await redis.client.quit();
    await db.pool.end();
  } catch (_) {}
  process.exit(0);
});

start();

module.exports = app; // export for testing
