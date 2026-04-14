const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const redis = require('../config/redis');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '30d';
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Characters that are unambiguous to read aloud or type
const JOIN_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function generateUniqueJoinCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
    }
    const exists = await db.query('SELECT id FROM businesses WHERE join_code = $1', [code]);
    if (exists.rows.length === 0) return code;
  }
  throw new Error('Could not generate unique join code');
}

/**
 * Generate an access token and a refresh token for a user.
 */
function generateTokens(payload) {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
  return { accessToken, refreshToken };
}

/**
 * Store a refresh token in Redis with a 30-day TTL.
 * Key pattern: refresh:{userId}:{tokenHash}
 */
async function storeRefreshToken(userId, refreshToken) {
  const key = `refresh:${userId}:${Buffer.from(refreshToken).toString('base64').slice(0, 20)}`;
  await redis.set(key, refreshToken, REFRESH_TOKEN_TTL_SECONDS);
  return key;
}

// ---------------------------------------------------------------------------
// POST /api/auth/business/register
// ---------------------------------------------------------------------------
router.post(
  '/business/register',
  [
    body('owner_name').trim().notEmpty().withMessage('Owner name is required'),
    body('business_name_ar').trim().notEmpty().withMessage('Arabic business name is required'),
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { owner_name, business_name_ar, business_name_en, business_type, phone, email, password, fcm_token } = req.body;

    try {
      // Check uniqueness
      const existing = await db.query(
        'SELECT id FROM businesses WHERE email = $1 OR phone = $2',
        [email, phone]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Email or phone already registered' });
      }

      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
      const join_code = await generateUniqueJoinCode();

      const result = await db.query(
        `INSERT INTO businesses
           (owner_name, business_name_ar, business_name_en, business_type, phone, email, password_hash, join_code, fcm_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, owner_name, business_name_ar, business_name_en, email, phone, brand_color, join_code, is_active, created_at`,
        [owner_name, business_name_ar, business_name_en || null, business_type || null, phone, email, password_hash, join_code, fcm_token || null]
      );

      const business = result.rows[0];
      const payload = { id: business.id, type: 'business', email: business.email };
      const { accessToken, refreshToken } = generateTokens(payload);
      await storeRefreshToken(business.id, refreshToken);

      return res.status(201).json({
        success: true,
        data: {
          business,
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      });
    } catch (err) {
      console.error('Business register error:', err.message);
      return res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/auth/business/login
// ---------------------------------------------------------------------------
router.post(
  '/business/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { email, password, fcm_token } = req.body;

    try {
      const result = await db.query(
        `SELECT id, owner_name, business_name_ar, business_name_en, email, phone,
                password_hash, brand_color, logo_url, join_code, fcm_token, is_active, created_at
         FROM businesses WHERE email = $1`,
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const business = result.rows[0];
      const passwordMatch = await bcrypt.compare(password, business.password_hash);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Update FCM token if provided
      if (fcm_token && fcm_token !== business.fcm_token) {
        await db.query(
          'UPDATE businesses SET fcm_token = $1 WHERE id = $2',
          [fcm_token, business.id]
        );
      }

      const payload = { id: business.id, type: 'business', email: business.email };
      const { accessToken, refreshToken } = generateTokens(payload);
      await storeRefreshToken(business.id, refreshToken);

      const { password_hash, ...businessData } = business;

      return res.json({
        success: true,
        data: {
          business: businessData,
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      });
    } catch (err) {
      console.error('Business login error:', err.message);
      return res.status(500).json({ error: 'Login failed' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/auth/customer/register
// ---------------------------------------------------------------------------
router.post(
  '/customer/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('email').optional().isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { name, phone, email, password, fcm_token } = req.body;

    try {
      // Check uniqueness by phone
      const existing = await db.query(
        'SELECT id FROM customers WHERE phone = $1',
        [phone]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Phone number already registered' });
      }

      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

      const result = await db.query(
        `INSERT INTO customers (name, phone, email, password_hash, fcm_token)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, phone, email, created_at`,
        [name, phone, email || null, password_hash, fcm_token || null]
      );

      const customer = result.rows[0];
      const payload = { id: customer.id, type: 'customer', email: customer.email };
      const { accessToken, refreshToken } = generateTokens(payload);
      await storeRefreshToken(customer.id, refreshToken);

      return res.status(201).json({
        success: true,
        data: {
          customer,
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      });
    } catch (err) {
      console.error('Customer register error:', err.message);
      return res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/auth/customer/login
// ---------------------------------------------------------------------------
router.post(
  '/customer/login',
  [
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { phone, password, fcm_token } = req.body;

    try {
      const result = await db.query(
        'SELECT id, name, phone, email, password_hash, fcm_token, created_at FROM customers WHERE phone = $1',
        [phone]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid phone or password' });
      }

      const customer = result.rows[0];
      const passwordMatch = await bcrypt.compare(password, customer.password_hash);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid phone or password' });
      }

      // Update FCM token if provided
      if (fcm_token && fcm_token !== customer.fcm_token) {
        await db.query(
          'UPDATE customers SET fcm_token = $1 WHERE id = $2',
          [fcm_token, customer.id]
        );
      }

      const payload = { id: customer.id, type: 'customer', email: customer.email };
      const { accessToken, refreshToken } = generateTokens(payload);
      await storeRefreshToken(customer.id, refreshToken);

      const { password_hash, ...customerData } = customer;

      return res.json({
        success: true,
        data: {
          customer: customerData,
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      });
    } catch (err) {
      console.error('Customer login error:', err.message);
      return res.status(500).json({ error: 'Login failed' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------
router.post(
  '/refresh',
  [body('refresh_token').notEmpty().withMessage('Refresh token is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { refresh_token } = req.body;

    try {
      // Verify the refresh token signature and expiry
      let decoded;
      try {
        decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
      } catch (jwtErr) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }

      // Verify the token is stored in Redis (not invalidated/logged out)
      const redisKey = `refresh:${decoded.id}:${Buffer.from(refresh_token).toString('base64').slice(0, 20)}`;
      const storedToken = await redis.get(redisKey);

      if (!storedToken || storedToken !== refresh_token) {
        return res.status(401).json({ error: 'Refresh token has been revoked' });
      }

      // Issue a fresh access token
      const payload = { id: decoded.id, type: decoded.type, email: decoded.email };
      const newAccessToken = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRY,
      });

      return res.json({
        success: true,
        data: { access_token: newAccessToken },
      });
    } catch (err) {
      console.error('Token refresh error:', err.message);
      return res.status(500).json({ error: 'Token refresh failed' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', async (req, res) => {
  const { refresh_token } = req.body;

  if (refresh_token) {
    try {
      const decoded = jwt.decode(refresh_token);
      if (decoded && decoded.id) {
        const redisKey = `refresh:${decoded.id}:${Buffer.from(refresh_token).toString('base64').slice(0, 20)}`;
        await redis.del(redisKey);
      }
    } catch (_) {
      // Ignore errors during logout token cleanup
    }
  }

  return res.json({ success: true, message: 'Logged out successfully' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/fcm-token
// Save or update the FCM device token for the authenticated user.
// Supports both business and customer accounts.
// ---------------------------------------------------------------------------
router.post(
  '/fcm-token',
  authMiddleware,
  [
    body('fcm_token').trim().notEmpty().withMessage('fcm_token is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { fcm_token } = req.body;
    const { id, type } = req.user;
    const table = type === 'business' ? 'businesses' : 'customers';

    try {
      await db.query(
        `UPDATE ${table} SET fcm_token = $1 WHERE id = $2`,
        [fcm_token, id]
      );
      return res.json({ success: true });
    } catch (err) {
      console.error('fcm-token save error:', err.message);
      return res.status(500).json({ error: 'Failed to save FCM token' });
    }
  }
);

module.exports = router;
