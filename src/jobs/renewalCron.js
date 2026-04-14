const cron = require('node-cron');
const { processAutoRenewals } = require('../services/renewal');

/**
 * Daily cron job that runs at 9:00 AM to process auto-renewals.
 * Schedule: '0 9 * * *' (every day at 09:00)
 */
function startRenewalCron() {
  const schedule = process.env.RENEWAL_CRON_SCHEDULE || '0 9 * * *';

  console.log(`Scheduling auto-renewal cron job: "${schedule}"`);

  const task = cron.schedule(schedule, async () => {
    console.log(`[${new Date().toISOString()}] Auto-renewal cron triggered`);
    try {
      const result = await processAutoRenewals();
      console.log(
        `[${new Date().toISOString()}] Auto-renewal cron finished:`,
        JSON.stringify(result)
      );
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Auto-renewal cron error:`, err.message);
    }
  });

  task.start();
  console.log('Auto-renewal cron job scheduled successfully');
  return task;
}

module.exports = { startRenewalCron };
