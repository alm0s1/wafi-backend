/**
 * Thawani Pay integration service.
 * Handles payment session creation, status checks, and customer token management.
 *
 * API Reference: https://docs.thawani.om
 */

const THAWANI_SECRET = () => process.env.THAWANI_SECRET_KEY;
const THAWANI_PUBLISHABLE_KEY = () => process.env.THAWANI_PUBLISHABLE_KEY;
const THAWANI_BASE = () => process.env.THAWANI_BASE_URL || 'https://uatcheckout.thawani.om/api/v1';

const PLANS = {
  quarterly: {
    amount: 15000,       // in baisa (150.000 OMR)
    name: 'وافي - ربع سنوي',
    months: 3,
  },
  semi_annual: {
    amount: 25000,       // 250.000 OMR
    name: 'وافي - نصف سنوي',
    months: 6,
  },
  annual: {
    amount: 40000,       // 400.000 OMR
    name: 'وافي - سنوي',
    months: 12,
  },
};

/**
 * Returns the plan config for a given plan key.
 * @param {string} plan
 * @returns {{ amount: number, name: string, months: number }}
 */
function getPlanConfig(plan) {
  const config = PLANS[plan];
  if (!config) {
    throw new Error(`Invalid plan: ${plan}. Must be one of: ${Object.keys(PLANS).join(', ')}`);
  }
  return config;
}

/**
 * Build common headers for Thawani API requests.
 * @returns {object}
 */
function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'thawani-api-key': THAWANI_SECRET(),
  };
}

/**
 * Create a Thawani checkout session for a subscription plan.
 *
 * @param {object} params
 * @param {string} params.plan - 'quarterly' | 'semi_annual' | 'annual'
 * @param {string} params.businessId - UUID of the business
 * @param {string} params.businessEmail - Business email for customer reference
 * @param {string} params.successUrl - Redirect URL on payment success
 * @param {string} params.cancelUrl - Redirect URL on payment cancel
 * @returns {Promise<{ sessionId: string, paymentUrl: string, plan: object }>}
 */
async function createSession({ plan, businessId, businessEmail, successUrl, cancelUrl }) {
  const planConfig = getPlanConfig(plan);

  const body = {
    client_reference_id: businessId,
    mode: 'payment',
    products: [
      {
        name: planConfig.name,
        quantity: 1,
        unit_amount: planConfig.amount,
      },
    ],
    success_url: successUrl || `${process.env.APP_URL || 'http://localhost:3000'}/payment/success`,
    cancel_url: cancelUrl || `${process.env.APP_URL || 'http://localhost:3000'}/payment/cancel`,
    metadata: {
      business_id: businessId,
      plan,
    },
  };

  const response = await fetch(`${THAWANI_BASE()}/checkout/session`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });

  const json = await response.json();

  if (!response.ok || !json.data) {
    throw new Error(
      `Thawani createSession failed (${response.status}): ${JSON.stringify(json)}`
    );
  }

  const sessionId = json.data.session_id;
  const paymentUrl = `https://uatcheckout.thawani.om/pay/${sessionId}?key=${THAWANI_PUBLISHABLE_KEY()}`;

  return { sessionId, paymentUrl, plan: planConfig };
}

/**
 * Retrieve the status of a Thawani checkout session.
 *
 * @param {string} sessionId
 * @returns {Promise<{ status: string, receipt: string|null, rawData: object }>}
 */
async function getSessionStatus(sessionId) {
  const response = await fetch(
    `${THAWANI_BASE()}/checkout/session/${sessionId}`,
    {
      method: 'GET',
      headers: buildHeaders(),
    }
  );

  const json = await response.json();

  if (!response.ok || !json.data) {
    throw new Error(
      `Thawani getSessionStatus failed (${response.status}): ${JSON.stringify(json)}`
    );
  }

  const data = json.data;

  return {
    status: data.payment_status,   // 'paid' | 'unpaid' | 'expired' etc.
    receipt: data.invoice || null,
    rawData: data,
  };
}

/**
 * Create a Thawani customer token for recurring billing.
 * This saves the customer's payment method for future auto-charges.
 *
 * @param {string} businessEmail
 * @returns {Promise<string>} - The customer token
 */
async function createCustomerToken(businessEmail) {
  const response = await fetch(`${THAWANI_BASE()}/customers`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({ email: businessEmail }),
  });

  const json = await response.json();

  if (!response.ok || !json.data) {
    throw new Error(
      `Thawani createCustomerToken failed (${response.status}): ${JSON.stringify(json)}`
    );
  }

  return json.data.id || json.data.token || json.data.customer_id;
}

/**
 * Charge a customer using their saved Thawani token (for auto-renewal).
 *
 * @param {object} params
 * @param {string} params.customerToken - Stored Thawani customer token
 * @param {string} params.plan - 'quarterly' | 'semi_annual' | 'annual'
 * @param {string} params.businessId - UUID of the business
 * @returns {Promise<{ success: boolean, receipt: string|null, rawData: object }>}
 */
async function chargeCustomer({ customerToken, plan, businessId }) {
  const planConfig = getPlanConfig(plan);

  const body = {
    customer_id: customerToken,
    client_reference_id: businessId,
    products: [
      {
        name: planConfig.name,
        quantity: 1,
        unit_amount: planConfig.amount,
      },
    ],
  };

  const response = await fetch(`${THAWANI_BASE()}/payment_intents`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(
      `Thawani chargeCustomer failed (${response.status}): ${JSON.stringify(json)}`
    );
  }

  const data = json.data || {};
  const success = data.status === 'succeeded' || data.payment_status === 'paid';

  return {
    success,
    receipt: data.invoice || data.receipt || null,
    rawData: data,
  };
}

module.exports = {
  PLANS,
  getPlanConfig,
  createSession,
  getSessionStatus,
  createCustomerToken,
  chargeCustomer,
};
