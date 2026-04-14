const { getMessaging } = require('../config/firebase');
const db = require('../config/database');

/**
 * Send a Firebase Cloud Messaging push notification.
 * Silently skips if no token is provided or if FCM is not configured.
 *
 * @param {object} options
 * @param {string} options.token - FCM device token
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body
 * @param {object} [options.data] - Optional key-value data payload
 */
async function sendFCM({ token, title, body, data = {} }) {
  if (!token) return;

  const messaging = getMessaging();
  if (!messaging) {
    console.warn('FCM not initialized — skipping push notification');
    return;
  }

  // FCM data values must be strings
  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    stringData[key] = String(value);
  }

  try {
    await messaging.send({
      token,
      notification: { title, body },
      data: stringData,
      android: {
        notification: {
          sound: 'default',
          priority: 'high',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });
  } catch (err) {
    // Log but never propagate FCM errors — push failure must not break the main flow
    console.error('FCM send error:', err.message);
  }
}

/**
 * Insert a notification record into the database.
 *
 * @param {object} options
 * @param {string} options.recipientId - UUID of recipient
 * @param {string} options.recipientType - 'business' | 'customer'
 * @param {string} options.title
 * @param {string} options.body
 * @param {string} options.type - Notification category (e.g. 'stamp_added', 'reward_earned')
 */
async function logNotification({ recipientId, recipientType, title, body, type }) {
  try {
    await db.query(
      `INSERT INTO notifications (recipient_id, recipient_type, title, body, type)
       VALUES ($1, $2, $3, $4, $5)`,
      [recipientId, recipientType, title, body, type]
    );
  } catch (err) {
    // Don't fail the request if logging fails
    console.error('Failed to log notification:', err.message);
  }
}

/**
 * Send FCM and log notification in DB in one call.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.recipientId
 * @param {string} options.recipientType
 * @param {string} options.title
 * @param {string} options.body
 * @param {string} options.type
 * @param {object} [options.data]
 */
async function notify({ token, recipientId, recipientType, title, body, type, data }) {
  await Promise.all([
    sendFCM({ token, title, body, data }),
    logNotification({ recipientId, recipientType, title, body, type }),
  ]);
}

/**
 * Send a data-only (silent) FCM message — no visible notification.
 * Used for background data sync such as card design updates.
 *
 * @param {object} options
 * @param {string} options.token - FCM device token
 * @param {object} options.data - Key-value data payload
 */
async function sendDataMessage({ token, data = {} }) {
  if (!token) return;

  const messaging = getMessaging();
  if (!messaging) {
    console.warn('FCM not initialized — skipping data message');
    return;
  }

  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    stringData[key] = String(value);
  }

  try {
    await messaging.send({
      token,
      data: stringData,
      android: {
        priority: 'high',
      },
      apns: {
        payload: {
          aps: {
            'content-available': 1,
          },
        },
      },
    });
  } catch (err) {
    console.error('FCM data message error:', err.message);
  }
}

module.exports = { sendFCM, sendDataMessage, logNotification, notify };
