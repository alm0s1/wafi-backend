const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { authMiddleware, requireType } = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { notify, sendDataMessage } = require('../services/notifications');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/stamps/add
// Core QR scan feature: business scans customer QR code and adds a stamp.
// ---------------------------------------------------------------------------
router.post(
  '/add',
  authMiddleware,
  requireType('business'),
  checkSubscription,
  [body('qr_token').trim().notEmpty().withMessage('QR token is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    const { qr_token } = req.body;
    const businessId = req.user.id;

    try {
      // 1. Find the loyalty card by QR token
      const cardResult = await db.query(
        'SELECT * FROM loyalty_cards WHERE qr_token = $1 AND is_active = true',
        [qr_token]
      );

      if (cardResult.rows.length === 0) {
        return res.status(404).json({ error: 'QR غير صالح' });
      }

      const loyaltyCard = cardResult.rows[0];

      // Verify this card belongs to the scanning business
      if (loyaltyCard.business_id !== businessId) {
        return res.status(403).json({ error: 'غير مصرح' });
      }

      // 2. Insert a stamp record
      await db.query(
        `INSERT INTO stamps (loyalty_card_id, business_id, added_by)
         VALUES ($1, $2, 'business')`,
        [loyaltyCard.id, businessId]
      );

      // 3. Calculate new stamp count and whether the card is now complete
      const newStamps = loyaltyCard.current_stamps + 1;
      const isComplete = newStamps >= loyaltyCard.stamps_required;

      await db.query(
        `UPDATE loyalty_cards
         SET current_stamps = $1,
             total_completed = total_completed + $2
         WHERE id = $3`,
        [isComplete ? 0 : newStamps, isComplete ? 1 : 0, loyaltyCard.id]
      );

      // 4. Fetch customer and business info for notifications (done in parallel)
      const [customerResult, businessResult] = await Promise.all([
        db.query('SELECT id, name, fcm_token FROM customers WHERE id = $1', [loyaltyCard.customer_id]),
        db.query('SELECT id, business_name_ar, fcm_token FROM businesses WHERE id = $1', [businessId]),
      ]);

      const customer = customerResult.rows[0];
      const business = businessResult.rows[0];

      // 5. Log and send notifications (fire-and-forget — never block the response)
      const notifyCustomer = () => {
        if (isComplete) {
          return notify({
            token: customer?.fcm_token,
            recipientId: customer?.id,
            recipientType: 'customer',
            title: 'مبروك! اكتملت بطاقتك 🎉',
            body: `استلم مكافأتك: ${loyaltyCard.reward_description || 'مكافأة مجانية'}`,
            type: 'reward_earned',
            data: {
              card_id: loyaltyCard.id,
              business_id: businessId,
              stamps_completed: loyaltyCard.stamps_required,
            },
          });
        } else {
          return notify({
            token: customer?.fcm_token,
            recipientId: customer?.id,
            recipientType: 'customer',
            title: 'تم إضافة طابع جديد!',
            body: `لديك الآن ${newStamps} من ${loyaltyCard.stamps_required} طوابع في ${business?.business_name_ar}`,
            type: 'stamp_added',
            data: {
              card_id: loyaltyCard.id,
              business_id: businessId,
              current_stamps: newStamps,
              stamps_required: loyaltyCard.stamps_required,
            },
          });
        }
      };

      // Notify the business owner via FCM and DB log
      const notifyBusiness = () =>
        notify({
          token: business?.fcm_token ?? null,
          recipientId: businessId,
          recipientType: 'business',
          title: isComplete ? 'عميل أكمل بطاقته!' : 'تم إضافة طابع',
          body: isComplete
            ? `${customer?.name || 'عميل'} أكمل بطاقته`
            : `تم إضافة طابع للعميل ${customer?.name || ''}`,
          type: isComplete ? 'customer_reward_earned' : 'stamp_issued',
          data: { card_id: loyaltyCard.id, customer_id: loyaltyCard.customer_id },
        });

      // Fire notifications asynchronously — do not await, do not propagate errors
      Promise.all([notifyCustomer(), notifyBusiness()]).catch((err) => {
        console.error('Notification error (non-fatal):', err.message);
      });

      // Fire-and-forget: silent data message so customer app refreshes in real-time
      if (customer?.fcm_token) {
        sendDataMessage({
          token: customer.fcm_token,
          data: {
            type: 'stamp_added',
            card_id: loyaltyCard.id,
            business_id: businessId,
            current_stamps: String(isComplete ? 0 : newStamps),
            stamps_required: String(loyaltyCard.stamps_required),
          },
        }).catch(err => console.error('stamp_added data message error:', err.message));
      }

      return res.json({
        success: true,
        data: {
          current_stamps: isComplete ? 0 : newStamps,
          stamps_required: loyaltyCard.stamps_required,
          completed: isComplete,
          reward_description: isComplete ? loyaltyCard.reward_description : null,
          customer_name: customer?.name || null,
        },
      });
    } catch (err) {
      console.error('stamps/add error:', err.message);
      return res.status(500).json({ error: 'Failed to add stamp' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/stamps/card/:card_id
// Get all stamps for a specific loyalty card (business or owning customer).
// ---------------------------------------------------------------------------
router.get('/card/:card_id', authMiddleware, async (req, res) => {
  const { card_id } = req.params;
  const { user } = req;

  try {
    // First verify access
    const cardResult = await db.query(
      'SELECT business_id, customer_id FROM loyalty_cards WHERE id = $1',
      [card_id]
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

    const stampsResult = await db.query(
      `SELECT s.id, s.added_by, s.created_at
       FROM stamps s
       WHERE s.loyalty_card_id = $1
       ORDER BY s.created_at DESC`,
      [card_id]
    );

    return res.json({
      success: true,
      data: stampsResult.rows,
    });
  } catch (err) {
    console.error('stamps/card/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stamps' });
  }
});

module.exports = router;
