const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const thawani = require('../services/thawani');
const { authMiddleware, requireType } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/subscription/create-session
// Create a Thawani checkout session and a pending subscription record.
// ---------------------------------------------------------------------------
router.post(
  '/create-session',
  authMiddleware,
  requireType('business'),
  [
    body('plan')
      .isIn(['quarterly', 'semi_annual', 'annual'])
      .withMessage('Plan must be quarterly, semi_annual, or annual'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { plan } = req.body;
    const businessId = req.user.id;

    try {
      // Fetch the business email for reference
      const bizResult = await db.query(
        'SELECT id, email FROM businesses WHERE id = $1',
        [businessId]
      );
      if (bizResult.rows.length === 0) {
        return res.status(404).json({ error: 'Business not found' });
      }

      const business = bizResult.rows[0];
      const planConfig = thawani.getPlanConfig(plan);

      const { sessionId, paymentUrl } = await thawani.createSession({
        plan,
        businessId,
        businessEmail: business.email,
      });

      // Placeholder dates — will be updated to real dates on payment verification
      const now = new Date();
      const futureDate = new Date(now);
      futureDate.setMonth(futureDate.getMonth() + planConfig.months);

      await db.query(
        `INSERT INTO subscriptions
           (business_id, plan, amount_baisa, start_date, end_date, status, thawani_session_id)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [
          businessId,
          plan,
          planConfig.amount,
          now.toISOString().split('T')[0],
          futureDate.toISOString().split('T')[0],
          sessionId,
        ]
      );

      return res.status(201).json({
        success: true,
        data: {
          session_id: sessionId,
          payment_url: paymentUrl,
          plan,
          amount_baisa: planConfig.amount,
        },
      });
    } catch (err) {
      console.error('create-session error:', err.message);
      return res.status(500).json({ error: 'Failed to create payment session' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/subscription/verify/:session_id
// Verify payment status with Thawani and activate subscription if paid.
// ---------------------------------------------------------------------------
router.get(
  '/verify/:session_id',
  authMiddleware,
  requireType('business'),
  async (req, res) => {
    const { session_id } = req.params;
    const businessId = req.user.id;

    try {
      // Make sure the session belongs to this business
      const subResult = await db.query(
        `SELECT * FROM subscriptions
         WHERE thawani_session_id = $1 AND business_id = $2`,
        [session_id, businessId]
      );

      if (subResult.rows.length === 0) {
        return res.status(404).json({ error: 'Subscription session not found' });
      }

      const subscription = subResult.rows[0];

      // If already active, return early
      if (subscription.status === 'active') {
        return res.json({
          success: true,
          data: { subscription, already_active: true },
        });
      }

      const { status, receipt } = await thawani.getSessionStatus(session_id);

      if (status === 'paid') {
        const planConfig = thawani.getPlanConfig(subscription.plan);
        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + planConfig.months);

        const updated = await db.query(
          `UPDATE subscriptions
           SET status = 'active',
               start_date = $1,
               end_date = $2,
               thawani_receipt = $3
           WHERE id = $4
           RETURNING *`,
          [
            startDate.toISOString().split('T')[0],
            endDate.toISOString().split('T')[0],
            receipt,
            subscription.id,
          ]
        );

        // Activate the business account
        await db.query(
          'UPDATE businesses SET is_active = true WHERE id = $1',
          [businessId]
        );

        return res.json({
          success: true,
          data: {
            subscription: updated.rows[0],
            payment_status: 'paid',
          },
        });
      }

      // Not yet paid — return current status
      return res.json({
        success: true,
        data: {
          subscription,
          payment_status: status,
        },
      });
    } catch (err) {
      console.error('verify session error:', err.message);
      return res.status(500).json({ error: 'Failed to verify payment session' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/subscription/save-card
// Save a Thawani customer token for auto-renewal billing.
// ---------------------------------------------------------------------------
router.post(
  '/save-card',
  authMiddleware,
  requireType('business'),
  async (req, res) => {
    const businessId = req.user.id;

    try {
      const bizResult = await db.query(
        'SELECT id, email FROM businesses WHERE id = $1',
        [businessId]
      );

      if (bizResult.rows.length === 0) {
        return res.status(404).json({ error: 'Business not found' });
      }

      const business = bizResult.rows[0];
      const customerToken = await thawani.createCustomerToken(business.email);

      await db.query(
        'UPDATE businesses SET thawani_customer_token = $1 WHERE id = $2',
        [customerToken, businessId]
      );

      return res.json({
        success: true,
        message: 'Payment method saved for auto-renewal',
      });
    } catch (err) {
      console.error('save-card error:', err.message);
      return res.status(500).json({ error: 'Failed to save payment method' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/subscription/status
// Get the current subscription status for the authenticated business.
// ---------------------------------------------------------------------------
router.get('/status', authMiddleware, requireType('business'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM subscriptions
       WHERE business_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: { has_subscription: false },
      });
    }

    const sub = result.rows[0];
    const isActive = sub.status === 'active' && new Date(sub.end_date) >= new Date();

    return res.json({
      success: true,
      data: {
        has_subscription: true,
        is_active: isActive,
        subscription: sub,
      },
    });
  } catch (err) {
    console.error('subscription status error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/subscription/toggle-auto-renew
// Toggle auto-renewal for the active subscription.
// ---------------------------------------------------------------------------
router.patch(
  '/toggle-auto-renew',
  authMiddleware,
  requireType('business'),
  [body('auto_renew').isBoolean().withMessage('auto_renew must be a boolean')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { auto_renew } = req.body;

    try {
      const result = await db.query(
        `UPDATE subscriptions
         SET auto_renew = $1
         WHERE business_id = $2
           AND status = 'active'
           AND end_date >= CURRENT_DATE
         RETURNING id, auto_renew`,
        [auto_renew, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No active subscription found' });
      }

      return res.json({
        success: true,
        data: { auto_renew: result.rows[0].auto_renew },
      });
    } catch (err) {
      console.error('toggle-auto-renew error:', err.message);
      return res.status(500).json({ error: 'Failed to update auto-renewal setting' });
    }
  }
);

module.exports = router;
