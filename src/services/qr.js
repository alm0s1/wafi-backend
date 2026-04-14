const { v4: uuidv4 } = require('uuid');

/**
 * Generate a unique QR token for a loyalty card.
 * Format: W-{8 uppercase alphanumeric chars}
 * Example: W-A3F9B2C1
 * @returns {string}
 */
function generateQRToken() {
  const segment = uuidv4().split('-')[0].toUpperCase();
  return `W-${segment}`;
}

module.exports = { generateQRToken };
