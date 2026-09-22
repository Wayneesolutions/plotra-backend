// src/workers/listingStatusCheckWorker.js
//
// Monthly listing status check + auto-delete (PR 4). Same repeatable-
// BullMQ-job pattern as wayneRingCallSyncWorker.js / paymentReminderWorker.js
// (PR 2) — registered once on module load, deduped by jobId across restarts.
const { Worker, Queue } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { processMonthlyStatusChecks } = require('../services/listingStatusCheckService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

const listingStatusCheckQueue = new Queue('listing-status-check-cycle', { connection: redisConnection });

console.log(`[Worker Engine] Initializing Monthly Listing Status Check Cycle...`);

const listingStatusCheckWorker = new Worker('listing-status-check-cycle', async (job) => {
  if (job.name !== 'daily-check') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on listing-status-check-cycle, skipping.`);
    return { success: false, skipped: true };
  }

  try {
    const result = await processMonthlyStatusChecks(knex);
    console.log(`[Job ${job.id}] Listing status check cycle: ${JSON.stringify(result)}`);
    return { success: true, ...result };
  } catch (error) {
    console.error(`[Job ${job.id}] Listing status check cycle failed:`, error.message);
    throw error; // let BullMQ retry — repeatable job, next scheduled tick also runs regardless
  }
}, { connection: redisConnection });

listingStatusCheckWorker.on('failed', (job, err) => {
  console.error(`❌ [Job ${job?.id}] Listing status check cycle task failed:`, err.message);
});

// Once daily at 10:00 server time (offset from PR 2's payment cron at 09:00
// so the two don't contend for the same DB connections/BSP rate limits in
// the same instant). Registered on every worker process boot — BullMQ
// dedupes repeatable jobs by jobId, safe across restarts/multiple instances.
listingStatusCheckQueue.add('daily-check', {}, {
  repeat: { pattern: '0 10 * * *' },
  jobId: 'listing-status-check-daily',
}).catch((err) => console.error('[Listing Status Check] Failed to register repeatable job:', err.message));

module.exports = listingStatusCheckWorker;
