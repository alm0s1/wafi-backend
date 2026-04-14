const db = require('../config/database');

/**
 * Middleware that checks whether the authenticated business has an active subscription.
 * Must be used AFTER authMiddleware.
 * Returns 403 if no active subscription exists.
 * Passes through if req.user.type is 'customer' (no subscription check needed).
 */
async function checkSubscription(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Only businesses need subscriptions
    if (req.user.type !== 'business') {
      return next();
    }

    const result = await db.query(
      `SELECT id FROM subscriptions
       WHERE business_id = $1
         AND status = 'active'
         AND end_date >= CURRENT_DATE
       LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        error: 'No active subscription',
        message: 'يرجى الاشتراك في أحد الخطط لاستخدام هذه الميزة',
      });
    }

    next();
  } catch (err) {
    console.error('checkSubscription middleware error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = checkSubscription;
