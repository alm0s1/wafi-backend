const admin = require('firebase-admin');

let messaging = null;

/**
 * Initialize Firebase Admin SDK.
 * Reads credentials from environment variables.
 * Safe to call multiple times — only initializes once.
 */
function initialize() {
  if (admin.apps.length > 0) {
    messaging = admin.messaging();
    return;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.warn(
      'Firebase credentials not fully configured. FCM notifications will be disabled.'
    );
    return;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        // Environment variables escape newlines; restore them
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });

    messaging = admin.messaging();
    console.log('Firebase Admin SDK initialized successfully');
  } catch (err) {
    console.error('Failed to initialize Firebase Admin SDK:', err.message);
  }
}

/**
 * Returns the Firebase Messaging instance, or null if not initialized.
 * @returns {import('firebase-admin').messaging.Messaging|null}
 */
function getMessaging() {
  return messaging;
}

module.exports = { initialize, getMessaging };
