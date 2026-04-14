const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration checks — read env vars lazily
// ---------------------------------------------------------------------------

function isAppleConfigured() {
  return !!(
    process.env.APPLE_PASS_TYPE_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_PASS_CERT_PATH &&
    process.env.APPLE_PASS_CERT_KEY_PATH &&
    process.env.APPLE_WWDR_CERT_PATH
  );
}

function isGoogleConfigured() {
  return !!(
    process.env.GOOGLE_WALLET_ISSUER_ID &&
    process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY_PATH
  );
}

// ---------------------------------------------------------------------------
// Apple Wallet — .pkpass generation via passkit-generator
// ---------------------------------------------------------------------------

/**
 * Generate an Apple Wallet .pkpass buffer for a loyalty card.
 *
 * @param {object} cardData
 * @param {string} cardData.business_name_ar
 * @param {string} cardData.brand_color - Hex color, e.g. '#1D9E75'
 * @param {number} cardData.current_stamps
 * @param {number} cardData.stamps_required
 * @param {string} cardData.reward_description
 * @param {string} cardData.qr_token
 * @param {string} cardData.card_id
 * @returns {Promise<Buffer>} .pkpass file contents
 */
async function generateApplePass(cardData) {
  if (!isAppleConfigured()) {
    throw new Error('Apple Wallet is not configured');
  }

  // Lazy-require so the app doesn't crash when passkit-generator is not installed
  const { PKPass } = require('passkit-generator');

  const certsDir = path.resolve(process.cwd());

  const pass = new PKPass(
    {},
    {
      wwdr: fs.readFileSync(path.resolve(certsDir, process.env.APPLE_WWDR_CERT_PATH)),
      signerCert: fs.readFileSync(path.resolve(certsDir, process.env.APPLE_PASS_CERT_PATH)),
      signerKey: fs.readFileSync(path.resolve(certsDir, process.env.APPLE_PASS_CERT_KEY_PATH)),
      signerKeyPassphrase: process.env.APPLE_PASS_CERT_PASSWORD || undefined,
    },
    {
      serialNumber: `wafi-${cardData.card_id}`,
      description: 'بطاقة ولاء وافي',
      organizationName: cardData.business_name_ar || 'وافي',
      passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID,
      teamIdentifier: process.env.APPLE_TEAM_ID,
      foregroundColor: 'rgb(255, 255, 255)',
      backgroundColor: hexToRgb(cardData.brand_color || '#1D9E75'),
      labelColor: 'rgb(255, 255, 255)',
    }
  );

  pass.type = 'generic';

  pass.headerFields.push({
    key: 'stamps',
    label: 'الطوابع',
    value: `${cardData.current_stamps || 0}/${cardData.stamps_required || 8}`,
  });

  pass.primaryFields.push({
    key: 'business',
    label: 'المتجر',
    value: cardData.business_name_ar || 'متجر',
  });

  pass.secondaryFields.push({
    key: 'reward',
    label: 'المكافأة',
    value: cardData.reward_description || 'مكافأة مجانية',
  });

  pass.setBarcodes({
    format: 'PKBarcodeFormatQR',
    message: cardData.qr_token,
    messageEncoding: 'iso-8859-1',
  });

  // Load icon images if they exist
  const assetsDir = path.resolve(process.cwd(), 'wallet-assets');
  const iconFiles = ['icon.png', 'icon@2x.png', 'logo.png', 'logo@2x.png'];
  for (const file of iconFiles) {
    const filePath = path.join(assetsDir, file);
    if (fs.existsSync(filePath)) {
      pass.addBuffer(file, fs.readFileSync(filePath));
    }
  }

  return pass.getAsBuffer();
}

// ---------------------------------------------------------------------------
// Google Wallet — JWT-based save URL
// ---------------------------------------------------------------------------

/**
 * Generate a Google Wallet "Save" URL for a loyalty card.
 *
 * @param {object} cardData - Same shape as generateApplePass
 * @returns {Promise<string>} Google Wallet save URL
 */
async function generateGoogleWalletUrl(cardData) {
  if (!isGoogleConfigured()) {
    throw new Error('Google Wallet is not configured');
  }

  const { GoogleAuth } = require('google-auth-library');

  const keyFilePath = path.resolve(process.cwd(), process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY_PATH);
  const credentials = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));

  const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID;
  const classSuffix = process.env.GOOGLE_WALLET_CLASS_SUFFIX || 'wafi_loyalty';
  const objectId = `${issuerId}.wafi-${cardData.card_id}`;
  const classId = `${issuerId}.${classSuffix}`;

  const loyaltyObject = {
    id: objectId,
    classId: classId,
    state: 'ACTIVE',
    heroImage: undefined,
    textModulesData: [
      {
        header: 'المكافأة',
        body: cardData.reward_description || 'مكافأة مجانية',
      },
    ],
    linksModuleData: undefined,
    barcode: {
      type: 'QR_CODE',
      value: cardData.qr_token,
    },
    loyaltyPoints: {
      label: 'الطوابع',
      balance: {
        int: cardData.current_stamps || 0,
      },
    },
    accountName: cardData.business_name_ar || 'متجر',
    accountId: cardData.card_id,
  };

  const claims = {
    iss: credentials.client_email,
    aud: 'google',
    origins: [],
    typ: 'savetowallet',
    payload: {
      loyaltyObjects: [loyaltyObject],
    },
  };

  const token = jwt.sign(claims, credentials.private_key, {
    algorithm: 'RS256',
  });

  return `https://pay.google.com/gp/v/save/${token}`;
}

// ---------------------------------------------------------------------------
// Download tokens — short-lived JWTs for unauthenticated .pkpass download
// ---------------------------------------------------------------------------

const DOWNLOAD_SECRET = process.env.JWT_SECRET || 'wallet-download-fallback';

function generateDownloadToken(cardId) {
  return jwt.sign({ cardId, purpose: 'wallet_download' }, DOWNLOAD_SECRET, {
    expiresIn: '5m',
  });
}

function verifyDownloadToken(token) {
  const decoded = jwt.verify(token, DOWNLOAD_SECRET);
  if (decoded.purpose !== 'wallet_download') {
    throw new Error('Invalid token purpose');
  }
  return { cardId: decoded.cardId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return 'rgb(29, 158, 117)';
  return `rgb(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)})`;
}

module.exports = {
  isAppleConfigured,
  isGoogleConfigured,
  generateApplePass,
  generateGoogleWalletUrl,
  generateDownloadToken,
  verifyDownloadToken,
};
