const db = require('../config/database');
const thawani = require('./thawani');
const { notify } = require('./notifications');

/**
 * Process auto-renewal for a single subscription.
 * Called from the renewalCron job.
 *
 * @param {object} subscription - Row from subscriptions table
 * @param {object} business - Row from businesses table
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function renewSubscription(subscription, business) {
  try {
    const chargeResult = await thawani.chargeCustomer({
      customerToken: business.thawani_customer_token,
      plan: subscription.plan,
      businessId: business.id,
    });

    if (!chargeResult.success) {
      throw new Error('Payment was not successful');
    }

    const planConfig = thawani.getPlanConfig(subscription.plan);

    // Calculate new subscription period starting from today
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + planConfig.months);

    await db.query(
      `INSERT INTO subscriptions
         (business_id, plan, amount_baisa, start_date, end_date, status, thawani_receipt, auto_renew)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, true)`,
      [
        business.id,
        subscription.plan,
        planConfig.amount,
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0],
        chargeResult.receipt,
      ]
    );

    // Ensure business remains active
    await db.query(
      'UPDATE businesses SET is_active = true WHERE id = $1',
      [business.id]
    );

    // Notify the business owner about successful renewal
    await notify({
      token: null, // businesses don't have FCM tokens in this schema; extend if needed
      recipientId: business.id,
      recipientType: 'business',
      title: 'تم تجديد اشتراكك',
      body: `تم تجديد اشتراكك في وافي بنجاح حتى ${endDate.toLocaleDateString('ar-OM')}`,
      type: 'subscription_renewed',
      data: { plan: subscription.plan, end_date: endDate.toISOString().split('T')[0] },
    });

    console.log(`Auto-renewal successful for business ${business.id} (plan: ${subscription.plan})`);
    return { success: true };
  } catch (err) {
    console.error(`Auto-renewal failed for business ${business.id}:`, err.message);

    // Notify the business owner about the failure
    await notify({
      token: null,
      recipientId: business.id,
      recipientType: 'business',
      title: 'فشل تجديد الاشتراك',
      body: 'لم نتمكن من تجديد اشتراكك تلقائياً. يرجى تجديده يدوياً.',
      type: 'subscription_renewal_failed',
      data: { plan: subscription.plan },
    });

    return { success: false, error: err.message };
  }
}

/**
 * Find all subscriptions expiring today that have auto_renew enabled
 * and a saved Thawani customer token, then attempt renewal for each.
 *
 * @returns {Promise<{ processed: number, succeeded: number, failed: number }>}
 */
async function processAutoRenewals() {
  console.log('Starting auto-renewal job...');

  const result = await db.query(
    `SELECT s.*, b.id AS business_id_alias, b.email, b.thawani_customer_token,
            b.owner_name, b.business_name_ar
     FROM subscriptions s
     JOIN businesses b ON b.id = s.business_id
     WHERE s.end_date = CURRENT_DATE
       AND s.auto_renew = true
       AND s.status = 'active'
       AND b.thawani_customer_token IS NOT NULL`,
    []
  );

  const subscriptions = result.rows;
  console.log(`Found ${subscriptions.length} subscription(s) due for auto-renewal`);

  let succeeded = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    const business = {
      id: sub.business_id,
      email: sub.email,
      thawani_customer_token: sub.thawani_customer_token,
      owner_name: sub.owner_name,
      business_name_ar: sub.business_name_ar,
    };

    const outcome = await renewSubscription(sub, business);
    if (outcome.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  console.log(`Auto-renewal job complete: ${succeeded} succeeded, ${failed} failed`);
  return { processed: subscriptions.length, succeeded, failed };
}

module.exports = { processAutoRenewals, renewSubscription };
