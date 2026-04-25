const express = require('express');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const { authMiddleware, requireType } = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { sendDataMessage } = require('../services/notifications');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/business/by-code/:code
// Public lookup: returns basic business info for a 6-char join code.
// Used by the customer app before calling /cards/join.
// Requires any authenticated user (customer or business).
// ---------------------------------------------------------------------------
router.get('/by-code/:code', authMiddleware, async (req, res) => {
  const { code } = req.params;
  try {
    const result = await db.query(
      `SELECT id, business_name_ar, business_name_en, brand_color,
              stamps_required, reward_description, logo_url
       FROM businesses
       WHERE upper(join_code) = upper($1) AND is_active = true`,
      [code]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'الرمز غير صحيح أو المتجر غير نشط' });
    }
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('by-code error:', err.message);
    return res.status(500).json({ error: 'Failed to find business' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/business/by-id/:id
// Lookup business info by UUID. Used by customer QR scanner before joining.
// ---------------------------------------------------------------------------
router.get('/by-id/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid business ID format' });
  }

  try {
    const result = await db.query(
      `SELECT id, business_name_ar, business_name_en, brand_color,
              stamps_required, reward_description, logo_url
       FROM businesses
       WHERE id = $1 AND is_active = true`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'المتجر غير موجود أو غير نشط' });
    }
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('by-id error:', err.message);
    return res.status(500).json({ error: 'Failed to find business' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/business/analytics
// Extended analytics: daily stamp trend (7 days), top customers, totals.
// ---------------------------------------------------------------------------
router.get(
  '/analytics',
  authMiddleware,
  requireType('business'),
  checkSubscription,
  async (req, res) => {
    const businessId = req.user.id;

    try {
      const [dailyStampsResult, topCustomersResult, overallResult] =
        await Promise.all([
          // Stamps per day for last 7 days
          db.query(
            `SELECT d::date AS date, COALESCE(COUNT(s.id), 0)::int AS count
             FROM generate_series(
               CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, '1 day'
             ) d
             LEFT JOIN stamps s
               ON s.business_id = $1
               AND s.created_at::date = d::date
             GROUP BY d::date
             ORDER BY d::date ASC`,
            [businessId]
          ),

          // Top 5 customers by stamp count
          db.query(
            `SELECT c.name, c.phone, COUNT(s.id)::int AS stamp_count,
                    MAX(s.created_at) AS last_stamp
             FROM stamps s
             JOIN loyalty_cards lc ON lc.id = s.loyalty_card_id
             JOIN customers c ON c.id = lc.customer_id
             WHERE s.business_id = $1
             GROUP BY c.id, c.name, c.phone
             ORDER BY stamp_count DESC
             LIMIT 5`,
            [businessId]
          ),

          // Overall stats
          db.query(
            `SELECT
               (SELECT COUNT(*)::int FROM stamps WHERE business_id = $1) AS total_stamps,
               (SELECT COUNT(DISTINCT customer_id)::int FROM loyalty_cards WHERE business_id = $1) AS total_customers,
               (SELECT COALESCE(SUM(total_completed), 0)::int FROM loyalty_cards WHERE business_id = $1) AS total_rewards,
               (SELECT COUNT(*)::int FROM loyalty_cards WHERE business_id = $1) AS total_cards`,
            [businessId]
          ),
        ]);

      return res.json({
        success: true,
        data: {
          daily_stamps: dailyStampsResult.rows,
          top_customers: topCustomersResult.rows,
          total_stamps: overallResult.rows[0]?.total_stamps ?? 0,
          total_customers: overallResult.rows[0]?.total_customers ?? 0,
          total_rewards: overallResult.rows[0]?.total_rewards ?? 0,
          total_cards: overallResult.rows[0]?.total_cards ?? 0,
        },
      });
    } catch (err) {
      console.error('analytics error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/business/dashboard
// Summary statistics and recent activity for the business owner dashboard.
// ---------------------------------------------------------------------------
router.get(
  '/dashboard',
  authMiddleware,
  requireType('business'),
  checkSubscription,
  async (req, res) => {
    const businessId = req.user.id;

    try {
      // Run all stats queries in parallel for performance
      const [
        totalCustomersResult,
        stampsTodayResult,
        rewardsWeekResult,
        recentActivityResult,
      ] = await Promise.all([
        // Distinct customers who have any loyalty card with this business
        db.query(
          `SELECT COUNT(DISTINCT customer_id)::int AS total_customers
           FROM loyalty_cards
           WHERE business_id = $1`,
          [businessId]
        ),

        // Stamps added today
        db.query(
          `SELECT COUNT(*)::int AS stamps_today
           FROM stamps
           WHERE business_id = $1
             AND created_at::date = CURRENT_DATE`,
          [businessId]
        ),

        // Cards completed (total_completed incremented) this calendar week
        db.query(
          `SELECT COALESCE(SUM(
             (SELECT COUNT(*) FROM stamps s
              WHERE s.loyalty_card_id = lc.id
                AND s.created_at >= date_trunc('week', NOW())
                AND s.business_id = $1)
           ), 0)::int AS rewards_this_week
           FROM loyalty_cards lc
           WHERE lc.business_id = $1
             AND lc.total_completed > 0`,
          [businessId]
        ),

        // Last 10 stamps with customer name and timestamp
        db.query(
          `SELECT
             s.id AS stamp_id,
             s.created_at AS stamp_time,
             c.name AS customer_name,
             c.phone AS customer_phone,
             lc.id AS card_id,
             lc.current_stamps,
             lc.stamps_required
           FROM stamps s
           JOIN loyalty_cards lc ON lc.id = s.loyalty_card_id
           JOIN customers c ON c.id = lc.customer_id
           WHERE s.business_id = $1
           ORDER BY s.created_at DESC
           LIMIT 10`,
          [businessId]
        ),
      ]);

      // Compute rewards_this_week differently — count stamps that resulted in completions
      // Simpler and more accurate: count rows where completing stamps were added this week
      const rewardsWeek = await db.query(
        `SELECT COUNT(*)::int AS rewards_this_week
         FROM stamps s
         JOIN loyalty_cards lc ON lc.id = s.loyalty_card_id
         WHERE s.business_id = $1
           AND s.created_at >= date_trunc('week', NOW())
           AND lc.total_completed > 0`,
        [businessId]
      );

      return res.json({
        success: true,
        data: {
          total_customers: totalCustomersResult.rows[0].total_customers,
          stamps_today: stampsTodayResult.rows[0].stamps_today,
          rewards_this_week: rewardsWeek.rows[0].rewards_this_week,
          recent_activity: recentActivityResult.rows,
        },
      });
    } catch (err) {
      console.error('dashboard error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/business/customers
// Full list of customers with their loyalty card info for this business.
// ---------------------------------------------------------------------------
router.get(
  '/customers',
  authMiddleware,
  requireType('business'),
  checkSubscription,
  async (req, res) => {
    const businessId = req.user.id;

    try {
      const result = await db.query(
        `SELECT
           c.id AS customer_id,
           c.name AS customer_name,
           c.phone AS customer_phone,
           c.email AS customer_email,
           c.created_at AS customer_joined,
           lc.id AS card_id,
           lc.stamps_required,
           lc.current_stamps,
           lc.total_completed,
           lc.reward_description,
           lc.qr_token,
           lc.is_active AS card_active,
           lc.created_at AS card_created,
           (SELECT COUNT(*) FROM stamps s WHERE s.loyalty_card_id = lc.id)::int AS total_stamps
         FROM loyalty_cards lc
         JOIN customers c ON c.id = lc.customer_id
         WHERE lc.business_id = $1
         ORDER BY lc.created_at DESC`,
        [businessId]
      );

      return res.json({
        success: true,
        data: result.rows,
      });
    } catch (err) {
      console.error('business/customers error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch customers' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/business/profile
// Fetch the business's own profile.
// ---------------------------------------------------------------------------
router.get('/profile', authMiddleware, requireType('business'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, owner_name, business_name_ar, business_name_en, business_type,
              phone, email, logo_url, brand_color, is_active, created_at
       FROM businesses
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('business/profile error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/business/profile
// Update the business's own profile (branding, names, etc).
// ---------------------------------------------------------------------------
router.patch(
  '/profile',
  authMiddleware,
  requireType('business'),
  [
    body('owner_name').optional().trim().notEmpty(),
    body('business_name_ar').optional().trim().notEmpty(),
    body('business_name_en').optional().trim(),
    body('business_type').optional().trim(),
    body('logo_url').optional().isURL().withMessage('logo_url must be a valid URL'),
    body('brand_color')
      .optional()
      .matches(/^#[0-9A-Fa-f]{6}$/)
      .withMessage('brand_color must be a valid hex color (e.g. #1D9E75)'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { owner_name, business_name_ar, business_name_en, business_type, logo_url, brand_color } =
      req.body;

    // Build a dynamic update query using only provided fields
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (owner_name !== undefined) { fields.push(`owner_name = $${paramIndex++}`); values.push(owner_name); }
    if (business_name_ar !== undefined) { fields.push(`business_name_ar = $${paramIndex++}`); values.push(business_name_ar); }
    if (business_name_en !== undefined) { fields.push(`business_name_en = $${paramIndex++}`); values.push(business_name_en); }
    if (business_type !== undefined) { fields.push(`business_type = $${paramIndex++}`); values.push(business_type); }
    if (logo_url !== undefined) { fields.push(`logo_url = $${paramIndex++}`); values.push(logo_url); }
    if (brand_color !== undefined) { fields.push(`brand_color = $${paramIndex++}`); values.push(brand_color); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    values.push(req.user.id);

    try {
      const result = await db.query(
        `UPDATE businesses
         SET ${fields.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, owner_name, business_name_ar, business_name_en, business_type,
                   phone, email, logo_url, brand_color, is_active`,
        values
      );

      return res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error('business/profile PATCH error:', err.message);
      return res.status(500).json({ error: 'Failed to update profile' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/business/notifications
// Fetch the last 50 notifications logged for this business.
// ---------------------------------------------------------------------------
router.get(
  '/notifications',
  authMiddleware,
  requireType('business'),
  async (req, res) => {
    try {
      const result = await db.query(
        `SELECT id, title, body, type, sent_at
         FROM notifications
         WHERE recipient_id = $1 AND recipient_type = 'business'
         ORDER BY sent_at DESC
         LIMIT 50`,
        [req.user.id]
      );

      return res.json({ success: true, data: result.rows });
    } catch (err) {
      console.error('business/notifications error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch notifications' });
    }
  }
);

// ---------------------------------------------------------------------------
// Multer setup for logo uploads
// ---------------------------------------------------------------------------
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo-${req.user.id}-${Date.now()}${ext}`);
  },
});

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مدعوم. يُسمح بـ JPG و PNG و WebP فقط'));
    }
  },
});

// ---------------------------------------------------------------------------
// Multer setup for stamp icon uploads (separate filename pattern)
// ---------------------------------------------------------------------------
const stampStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `stamp-${req.user.id}-${Date.now()}${ext}`);
  },
});

const stampUpload = multer({
  storage: stampStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مدعوم. يُسمح بـ JPG و PNG و WebP فقط'));
    }
  },
});

// ---------------------------------------------------------------------------
// POST /api/business/upload-logo
// Upload a business logo image and persist its URL.
// ---------------------------------------------------------------------------
router.post(
  '/upload-logo',
  authMiddleware,
  requireType('business'),
  (req, res, next) => {
    upload.single('logo')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'حجم الملف يتجاوز الحد المسموح (5 ميجا)' });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
    }

    const logoUrl = `/uploads/${req.file.filename}`;
    try {
      await db.query(
        `UPDATE businesses SET logo_url = $1 WHERE id = $2`,
        [logoUrl, req.user.id]
      );
      return res.json({ success: true, logo_url: logoUrl });
    } catch (err) {
      console.error('upload-logo error:', err.message);
      return res.status(500).json({ error: 'فشل حفظ الشعار' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/business/upload-stamp-icon
// Upload a custom stamp icon image and persist its URL.
// ---------------------------------------------------------------------------
router.post(
  '/upload-stamp-icon',
  authMiddleware,
  requireType('business'),
  (req, res, next) => {
    stampUpload.single('stamp_icon')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'حجم الملف يتجاوز الحد المسموح (5 ميجا)' });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
    }

    const stampIconUrl = `/uploads/${req.file.filename}`;
    try {
      await db.query(
        `UPDATE businesses SET stamp_icon_url = $1 WHERE id = $2`,
        [stampIconUrl, req.user.id]
      );
      // Propagate to all active loyalty cards
      await db.query(
        `UPDATE loyalty_cards SET stamp_icon_url = $1 WHERE business_id = $2 AND is_active = true`,
        [stampIconUrl, req.user.id]
      );
      return res.json({ success: true, stamp_icon_url: stampIconUrl });
    } catch (err) {
      console.error('upload-stamp-icon error:', err.message);
      return res.status(500).json({ error: 'فشل حفظ أيقونة الطابع' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/business/card-template
// Fetch the current card template settings for the authenticated business.
// Returns null stamps_required when the template has never been configured.
// ---------------------------------------------------------------------------
router.get(
  '/card-template',
  authMiddleware,
  requireType('business'),
  async (req, res) => {
    try {
      const result = await db.query(
        `SELECT id, business_name_ar, brand_color, stamps_required, reward_description, logo_url, stamp_icon_url
         FROM businesses WHERE id = $1`,
        [req.user.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Business not found' });
      }
      return res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error('GET card-template error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch card template' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/business/card-template
// Update card branding: brand_color, stamps_required, reward_description,
// business_name_ar. Also persists template values on businesses row and
// propagates stamps_required / reward_description to all active cards.
// ---------------------------------------------------------------------------
router.post(
  '/card-template',
  authMiddleware,
  requireType('business'),
  [
    body('brand_color')
      .optional()
      .matches(/^#[0-9A-Fa-f]{6}$/)
      .withMessage('brand_color must be a valid hex color'),
    body('stamps_required')
      .optional()
      .isInt({ min: 4, max: 12 })
      .withMessage('stamps_required must be between 4 and 12'),
    body('reward_description').optional().trim().isLength({ max: 200 }),
    body('business_name_ar').optional().trim().notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { brand_color, stamps_required, reward_description, business_name_ar, stamp_icon_url } = req.body;
    const businessId = req.user.id;

    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (brand_color !== undefined)        { fields.push(`brand_color = $${paramIndex++}`);        values.push(brand_color); }
    if (business_name_ar !== undefined)   { fields.push(`business_name_ar = $${paramIndex++}`);   values.push(business_name_ar); }
    if (stamps_required !== undefined)    { fields.push(`stamps_required = $${paramIndex++}`);    values.push(stamps_required); }
    if (reward_description !== undefined) { fields.push(`reward_description = $${paramIndex++}`); values.push(reward_description); }
    if (stamp_icon_url !== undefined)    { fields.push(`stamp_icon_url = $${paramIndex++}`);    values.push(stamp_icon_url); }

    try {
      let updatedBusiness;

      if (fields.length > 0) {
        values.push(businessId);
        const result = await db.query(
          `UPDATE businesses
           SET ${fields.join(', ')}
           WHERE id = $${paramIndex}
           RETURNING id, owner_name, business_name_ar, business_name_en,
                     brand_color, logo_url, stamp_icon_url, is_active`,
          values
        );
        updatedBusiness = result.rows[0];
      } else {
        const result = await db.query(
          `SELECT id, owner_name, business_name_ar, business_name_en,
                  brand_color, logo_url, stamp_icon_url, is_active
           FROM businesses WHERE id = $1`,
          [businessId]
        );
        updatedBusiness = result.rows[0];
      }

      // Propagate brand_color, stamps_required, reward_description, and/or stamp_icon_url to all active cards
      if (brand_color !== undefined || stamps_required !== undefined || reward_description !== undefined || stamp_icon_url !== undefined) {
        const cardFields = [];
        const cardValues = [];
        let cardIdx = 1;

        if (brand_color !== undefined)        { cardFields.push(`brand_color = $${cardIdx++}`);        cardValues.push(brand_color); }
        if (stamps_required !== undefined)    { cardFields.push(`stamps_required = $${cardIdx++}`);    cardValues.push(stamps_required); }
        if (reward_description !== undefined) { cardFields.push(`reward_description = $${cardIdx++}`); cardValues.push(reward_description); }
        if (stamp_icon_url !== undefined)     { cardFields.push(`stamp_icon_url = $${cardIdx++}`);     cardValues.push(stamp_icon_url); }

        cardValues.push(businessId);
        await db.query(
          `UPDATE loyalty_cards
           SET ${cardFields.join(', ')}
           WHERE business_id = $${cardIdx} AND is_active = true`,
          cardValues
        );

        // Fire-and-forget: notify affected customers via silent FCM
        db.query(
          `SELECT DISTINCT c.fcm_token
           FROM customers c
           JOIN loyalty_cards lc ON lc.customer_id = c.id
           WHERE lc.business_id = $1 AND lc.is_active = true AND c.fcm_token IS NOT NULL`,
          [businessId]
        ).then(tokenResult => {
          const tokens = tokenResult.rows.map(r => r.fcm_token);
          if (tokens.length > 0) {
            Promise.all(
              tokens.map(token =>
                sendDataMessage({ token, data: { type: 'card_update', business_id: businessId } })
              )
            ).catch(err => console.error('FCM card_update batch error:', err.message));
          }
        }).catch(err => console.error('FCM token query error:', err.message));
      }

      return res.json({ success: true, business: updatedBusiness });
    } catch (err) {
      console.error('card-template error:', err.message);
      return res.status(500).json({ error: 'Failed to save card template' });
    }
  }
);

module.exports = router;
