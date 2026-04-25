const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { authMiddleware, requireType } = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { generateQRToken } = require('../services/qr');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/cards/create
// Business creates a loyalty card for a customer (by phone).
// Creates the customer account if it doesn't exist yet.
// ---------------------------------------------------------------------------
router.post(
  '/create',
  authMiddleware,
  requireType('business'),
  checkSubscription,
  [
    body('customer_phone').trim().notEmpty().withMessage('Customer phone is required'),
    body('stamps_required')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('stamps_required must be between 1 and 100'),
    body('reward_description')
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage('reward_description must be at most 200 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { customer_phone, stamps_required = 8, reward_description } = req.body;
    const businessId = req.user.id;

    try {
      // Find or create customer by phone
      let customerResult = await db.query(
        'SELECT id, name, phone, email FROM customers WHERE phone = $1',
        [customer_phone]
      );

      let customer;
      let isNewCustomer = false;

      if (customerResult.rows.length === 0) {
        // Auto-create a minimal customer account
        // They can set a proper password later via customer/register
        const tempPassword = await bcrypt.hash(customer_phone + Date.now(), 10);
        const insertResult = await db.query(
          `INSERT INTO customers (name, phone, password_hash)
           VALUES ($1, $2, $3)
           RETURNING id, name, phone, email`,
          [customer_phone, customer_phone, tempPassword]
        );
        customer = insertResult.rows[0];
        isNewCustomer = true;
      } else {
        customer = customerResult.rows[0];
      }

      // Check if an active card already exists for this customer at this business
      const existingCard = await db.query(
        `SELECT id FROM loyalty_cards
         WHERE business_id = $1 AND customer_id = $2 AND is_active = true`,
        [businessId, customer.id]
      );

      if (existingCard.rows.length > 0) {
        return res.status(409).json({
          error: 'Customer already has an active loyalty card with this business',
        });
      }

      // Fetch business brand_color to embed on the card
      const bizResult = await db.query(
        'SELECT brand_color FROM businesses WHERE id = $1',
        [businessId]
      );
      const brandColor = bizResult.rows[0]?.brand_color || '#1D9E75';

      // Generate a unique QR token with collision retry
      let qr_token;
      let attempts = 0;
      while (attempts < 5) {
        const candidate = generateQRToken();
        const exists = await db.query(
          'SELECT id FROM loyalty_cards WHERE qr_token = $1',
          [candidate]
        );
        if (exists.rows.length === 0) {
          qr_token = candidate;
          break;
        }
        attempts++;
      }

      if (!qr_token) {
        return res.status(500).json({ error: 'Failed to generate unique QR token' });
      }

      const cardResult = await db.query(
        `INSERT INTO loyalty_cards
           (business_id, customer_id, stamps_required, reward_description, qr_token, brand_color)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [businessId, customer.id, stamps_required, reward_description || null, qr_token, brandColor]
      );

      const card = cardResult.rows[0];

      return res.status(201).json({
        success: true,
        data: {
          card,
          customer,
          is_new_customer: isNewCustomer,
        },
      });
    } catch (err) {
      console.error('cards/create error:', err.message);
      return res.status(500).json({ error: 'Failed to create loyalty card' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/cards/join
// Customer enters a 6-char join code and self-enrolls in the loyalty program.
// Creates a loyalty_card for the authenticated customer at the matching business.
// ---------------------------------------------------------------------------
router.post(
  '/join',
  authMiddleware,
  requireType('customer'),
  [
    body('join_code')
      .optional()
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage('join_code must be exactly 6 characters'),
    body('business_id')
      .optional()
      .isUUID()
      .withMessage('business_id must be a valid UUID'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { join_code, business_id } = req.body;
    const customerId = req.user.id;

    // At least one identifier is required
    if (!join_code && !business_id) {
      return res.status(400).json({ error: 'join_code or business_id is required' });
    }

    try {
      // Fetch business by ID or join code
      let bizResult;
      if (business_id) {
        bizResult = await db.query(
          `SELECT id, business_name_ar, brand_color, stamps_required, reward_description, is_active
           FROM businesses WHERE id = $1`,
          [business_id]
        );
      } else {
        bizResult = await db.query(
          `SELECT id, business_name_ar, brand_color, stamps_required, reward_description, is_active
           FROM businesses WHERE upper(join_code) = upper($1)`,
          [join_code]
        );
      }

      if (bizResult.rows.length === 0) {
        return res.status(404).json({ error: business_id ? 'المتجر غير موجود' : 'الرمز غير صحيح' });
      }

      const business = bizResult.rows[0];

      if (!business.is_active) {
        return res.status(403).json({ error: 'Business is not active' });
      }

      // Check if customer already has an active card with this business
      const existing = await db.query(
        `SELECT id FROM loyalty_cards
         WHERE business_id = $1 AND customer_id = $2 AND is_active = true`,
        [business.id, customerId]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          error: 'لديك بطاقة ولاء نشطة مع هذا المتجر بالفعل',
        });
      }

      // Use template values from businesses row, falling back to defaults
      const stampsRequired = business.stamps_required ?? 8;
      const rewardDescription = business.reward_description ?? null;
      const brandColor = business.brand_color || '#1D9E75';

      // Generate a unique QR token
      let qr_token;
      let attempts = 0;
      while (attempts < 5) {
        const candidate = generateQRToken();
        const exists = await db.query(
          'SELECT id FROM loyalty_cards WHERE qr_token = $1',
          [candidate]
        );
        if (exists.rows.length === 0) {
          qr_token = candidate;
          break;
        }
        attempts++;
      }

      if (!qr_token) {
        return res.status(500).json({ error: 'Failed to generate unique QR token' });
      }

      const cardResult = await db.query(
        `INSERT INTO loyalty_cards
           (business_id, customer_id, stamps_required, reward_description, qr_token, brand_color)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [business.id, customerId, stampsRequired, rewardDescription, qr_token, brandColor]
      );

      return res.status(201).json({
        success: true,
        data: {
          card: cardResult.rows[0],
          business: {
            id: business.id,
            business_name_ar: business.business_name_ar,
            brand_color: business.brand_color,
          },
        },
      });
    } catch (err) {
      console.error('cards/join error:', err.message);
      return res.status(500).json({ error: 'Failed to join loyalty program' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/cards/my-cards
// Customer retrieves all their loyalty cards with business details.
// ---------------------------------------------------------------------------
router.get(
  '/my-cards',
  authMiddleware,
  requireType('customer'),
  async (req, res) => {
    const customerId = req.user.id;

    try {
      const result = await db.query(
        `SELECT
           lc.id,
           lc.stamps_required,
           lc.current_stamps,
           lc.total_completed,
           lc.reward_description,
           lc.qr_token,
           lc.is_active,
           lc.created_at,
           COALESCE(lc.brand_color, b.brand_color) AS brand_color,
           b.id AS business_id,
           b.business_name_ar,
           b.business_name_en,
           b.logo_url,
           COALESCE(lc.stamp_icon_url, b.stamp_icon_url) AS stamp_icon_url,
           b.phone AS business_phone
         FROM loyalty_cards lc
         JOIN businesses b ON b.id = lc.business_id
         WHERE lc.customer_id = $1
         ORDER BY lc.created_at DESC`,
        [customerId]
      );

      return res.json({
        success: true,
        data: result.rows,
      });
    } catch (err) {
      console.error('my-cards error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch loyalty cards' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/cards/business-cards
// Business retrieves all loyalty cards it has issued, with customer info.
// ---------------------------------------------------------------------------
router.get(
  '/business-cards',
  authMiddleware,
  requireType('business'),
  checkSubscription,
  async (req, res) => {
    const businessId = req.user.id;

    try {
      const result = await db.query(
        `SELECT
           lc.id,
           lc.stamps_required,
           lc.current_stamps,
           lc.total_completed,
           lc.reward_description,
           lc.qr_token,
           lc.is_active,
           lc.created_at,
           c.id AS customer_id,
           c.name AS customer_name,
           c.phone AS customer_phone,
           c.email AS customer_email
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
      console.error('business-cards error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch business cards' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/cards/:id/history
// Returns stamp and reward history for a loyalty card (timeline events).
// MUST be defined before /:id to avoid Express matching "history" as an id.
// ---------------------------------------------------------------------------
router.get('/:id/history', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { user } = req;

  try {
    // Verify the card exists and check access
    const cardResult = await db.query(
      'SELECT business_id, customer_id, stamps_required, total_completed, reward_description FROM loyalty_cards WHERE id = $1',
      [id]
    );

    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Loyalty card not found' });
    }

    const card = cardResult.rows[0];
    const isOwningBusiness = user.type === 'business' && card.business_id === user.id;
    const isOwningCustomer = user.type === 'customer' && card.customer_id === user.id;

    if (!isOwningBusiness && !isOwningCustomer) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch all stamps for this card, chronological order
    const stampsResult = await db.query(
      `SELECT s.id, s.added_by, s.created_at
       FROM stamps s
       WHERE s.loyalty_card_id = $1
       ORDER BY s.created_at ASC`,
      [id]
    );

    // Build timeline events
    const events = [];
    const stamps = stampsResult.rows;
    let cycleStampCount = 0;
    let cycleNumber = 0;

    for (const stamp of stamps) {
      cycleStampCount++;

      // Stamp event
      events.push({
        id: stamp.id,
        type: 'stamp_added',
        date: stamp.created_at,
        stamp_number: cycleStampCount,
        stamps_required: card.stamps_required,
      });

      // If this stamp completes a cycle, add a reward event
      if (cycleStampCount >= card.stamps_required) {
        cycleNumber++;
        events.push({
          id: `reward-${cycleNumber}`,
          type: 'reward_earned',
          date: stamp.created_at,
          cycle: cycleNumber,
          reward_description: card.reward_description || null,
        });
        cycleStampCount = 0;
      }
    }

    // Return newest first
    events.reverse();

    return res.json({
      success: true,
      data: {
        events,
        total_stamps: stamps.length,
        total_rewards: card.total_completed,
      },
    });
  } catch (err) {
    console.error('cards/:id/history error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/cards/:id
// Get a single loyalty card by ID (accessible by owning business or customer).
// ---------------------------------------------------------------------------
router.get('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { user } = req;

  try {
    const result = await db.query(
      `SELECT
         lc.id, lc.business_id, lc.customer_id,
         lc.stamps_required, lc.current_stamps, lc.total_completed,
         lc.reward_description, lc.qr_token, lc.is_active, lc.created_at,
         COALESCE(lc.brand_color, b.brand_color) AS brand_color,
         b.business_name_ar, b.business_name_en, b.logo_url,
         COALESCE(lc.stamp_icon_url, b.stamp_icon_url) AS stamp_icon_url,
         b.join_code,
         c.name AS customer_name, c.phone AS customer_phone
       FROM loyalty_cards lc
       JOIN businesses b ON b.id = lc.business_id
       JOIN customers c ON c.id = lc.customer_id
       WHERE lc.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Loyalty card not found' });
    }

    const card = result.rows[0];

    // Access control: only the owning business or the customer can view the card
    const isOwningBusiness = user.type === 'business' && card.business_id === user.id;
    const isOwningCustomer = user.type === 'customer' && card.customer_id === user.id;

    if (!isOwningBusiness && !isOwningCustomer) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.json({ success: true, data: card });
  } catch (err) {
    console.error('cards/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch loyalty card' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/deactivate
// Business deactivates a loyalty card.
// ---------------------------------------------------------------------------
router.patch(
  '/:id/deactivate',
  authMiddleware,
  requireType('business'),
  checkSubscription,
  async (req, res) => {
    const { id } = req.params;
    const businessId = req.user.id;

    try {
      const result = await db.query(
        `UPDATE loyalty_cards
         SET is_active = false
         WHERE id = $1 AND business_id = $2
         RETURNING id, is_active`,
        [id, businessId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Card not found or not owned by this business' });
      }

      return res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error('deactivate card error:', err.message);
      return res.status(500).json({ error: 'Failed to deactivate card' });
    }
  }
);

module.exports = router;
