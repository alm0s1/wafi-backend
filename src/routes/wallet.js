const express = require('express');
const db = require('../config/database');
const { authMiddleware, requireType } = require('../middleware/auth');
const walletService = require('../services/wallet');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/cards/:id/wallet-status
// Check which wallet platforms are available (configured on the server).
// ---------------------------------------------------------------------------
router.get(
  '/:id/wallet-status',
  authMiddleware,
  requireType('customer'),
  async (req, res) => {
    return res.json({
      success: true,
      data: {
        apple_wallet: walletService.isAppleConfigured(),
        google_wallet: walletService.isGoogleConfigured(),
      },
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/cards/:id/wallet-pass?platform=apple|google
// Generate a wallet pass for the given loyalty card.
// ---------------------------------------------------------------------------
router.get(
  '/:id/wallet-pass',
  authMiddleware,
  requireType('customer'),
  async (req, res) => {
    const { id } = req.params;
    const { platform } = req.query;
    const customerId = req.user.id;

    if (!platform || !['apple', 'google'].includes(platform)) {
      return res.status(400).json({ error: 'platform query param must be "apple" or "google"' });
    }

    try {
      // Fetch card with business info
      const result = await db.query(
        `SELECT
           lc.id AS card_id, lc.business_id, lc.customer_id,
           lc.stamps_required, lc.current_stamps,
           lc.reward_description, lc.qr_token,
           COALESCE(lc.brand_color, b.brand_color) AS brand_color,
           b.business_name_ar
         FROM loyalty_cards lc
         JOIN businesses b ON b.id = lc.business_id
         WHERE lc.id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Loyalty card not found' });
      }

      const card = result.rows[0];

      if (card.customer_id !== customerId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const cardData = {
        card_id: card.card_id,
        business_name_ar: card.business_name_ar,
        brand_color: card.brand_color,
        current_stamps: card.current_stamps,
        stamps_required: card.stamps_required,
        reward_description: card.reward_description,
        qr_token: card.qr_token,
      };

      if (platform === 'apple') {
        if (!walletService.isAppleConfigured()) {
          return res.status(503).json({ error: 'Apple Wallet is not configured', wallet_available: false });
        }

        const downloadToken = walletService.generateDownloadToken(id);
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        return res.json({
          success: true,
          data: {
            download_url: `${baseUrl}/api/wallet/download/${downloadToken}`,
            platform: 'apple',
          },
        });
      }

      // Google Wallet
      if (!walletService.isGoogleConfigured()) {
        return res.status(503).json({ error: 'Google Wallet is not configured', wallet_available: false });
      }

      const saveUrl = await walletService.generateGoogleWalletUrl(cardData);
      return res.json({
        success: true,
        data: {
          save_url: saveUrl,
          platform: 'google',
        },
      });
    } catch (err) {
      console.error('wallet-pass error:', err.message);
      return res.status(500).json({ error: 'Failed to generate wallet pass' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/wallet/download/:token
// Unauthenticated endpoint — validates a short-lived JWT and serves .pkpass.
// ---------------------------------------------------------------------------
router.get(
  '/download/:token',
  async (req, res) => {
    const { token } = req.params;

    let cardId;
    try {
      const decoded = walletService.verifyDownloadToken(token);
      cardId = decoded.cardId;
    } catch (err) {
      return res.status(401).json({ error: 'Download link expired or invalid' });
    }

    try {
      const result = await db.query(
        `SELECT
           lc.id AS card_id, lc.stamps_required, lc.current_stamps,
           lc.reward_description, lc.qr_token, lc.is_active,
           COALESCE(lc.brand_color, b.brand_color) AS brand_color,
           b.business_name_ar
         FROM loyalty_cards lc
         JOIN businesses b ON b.id = lc.business_id
         WHERE lc.id = $1`,
        [cardId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Loyalty card not found' });
      }

      const card = result.rows[0];

      if (!card.is_active) {
        return res.status(410).json({ error: 'Loyalty card is no longer active' });
      }

      const passBuffer = await walletService.generateApplePass({
        card_id: card.card_id,
        business_name_ar: card.business_name_ar,
        brand_color: card.brand_color,
        current_stamps: card.current_stamps,
        stamps_required: card.stamps_required,
        reward_description: card.reward_description,
        qr_token: card.qr_token,
      });

      res.set({
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': 'attachment; filename="wafi-loyalty.pkpass"',
      });
      return res.send(passBuffer);
    } catch (err) {
      console.error('wallet download error:', err.message);
      return res.status(500).json({ error: 'Failed to generate wallet pass' });
    }
  }
);

module.exports = router;
