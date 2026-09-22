// src/workers/wayneRingCallSyncWorker.js
//
// Polling fallback for WayneRing call outcomes. A receiver for WayneRing's
// call.completed webhook now exists too (aivoicebackend PR #5 +
// src/controllers/wayneRingWebhookController.js, POST /api/v1/webhooks/wayne-ring)
// and triggers the same sync near-instantly, but this poll stays running
// deliberately — per PLOTRA_HANDOVER_FOR_SANT.md §10.8: "polling should stay
// on as a fallback for at least one full release cycle even after the
// webhook is wired, in case delivery silently fails for a tenant." Runs as a
// repeatable BullMQ job (registered once below, on module load) rather than
// reacting to an event.
const { Worker, Queue } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { syncOutboundCalls, syncInboundCalls } = require('../services/wayneRingSyncService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

const POLL_INTERVAL_MS = Number(process.env.WAYNERING_POLL_INTERVAL_MS) || 120000; // 2 min default — balance between timely outcomes and not hammering WayneRing's API

const wayneRingSyncQueue = new Queue('wayne-ring-sync', { connection: redisConnection });

console.log(`[Worker Engine] Initializing WayneRing Call Sync Poller...`);

// Checked once at module load, not per-tick — WAYNERING_BASE_URL/EMAIL/
// PASSWORD are read fresh from process.env here on purpose (env vars don't
// change without a process restart, so this is equivalent to checking every
// tick but without the wasted work). Missing credentials produced the exact
// same "WayneRing credentials not configured" error on every single poll in
// production — ~25k accumulated BullMQ failures and counting, all identical,
// none of them a transient condition a retry could ever fix. That's a
// deployment gap, not a code bug: the polling feature itself is deliberately
// kept running as a fallback (see file header) even after the webhook
// receiver exists, so this skips cleanly instead of removing the job.
const WAYNERING_CONFIGURED = !!(process.env.WAYNERING_BASE_URL && process.env.WAYNERING_EMAIL && process.env.WAYNERING_PASSWORD);
let loggedMissingWayneRingCredsOnce = false;

const wayneRingCallSyncWorker = new Worker('wayne-ring-sync', async (job) => {
  if (job.name !== 'poll-calls') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on wayne-ring-sync, skipping.`);
    return { success: false, skipped: true };
  }

  if (!WAYNERING_CONFIGURED) {
    if (!loggedMissingWayneRingCredsOnce) {
      console.warn(`[Job ${job.id}] WayneRing credentials not configured (WAYNERING_BASE_URL/EMAIL/PASSWORD) — skipping sync polls until they're set in production. This warning won't repeat.`);
      loggedMissingWayneRingCredsOnce = true;
    }
    return { success: true, skipped: 'not_configured' };
  }

  try {
    const outboundResult = await syncOutboundCalls(knex);
    const inboundResult = await syncInboundCalls(knex);
    console.log(`[Job ${job.id}] WayneRing sync — outbound: ${JSON.stringify(outboundResult)}, inbound: ${JSON.stringify(inboundResult)}`);
    return { success: true, outboundResult, inboundResult };
  } catch (error) {
    console.error(`[Job ${job.id}] WayneRing sync failed:`, error.message);
    throw error; // let BullMQ retry the next scheduled tick regardless — this is a repeatable job, not a one-off
  }
}, { connection: redisConnection });

wayneRingCallSyncWorker.on('failed', (job, err) => {
  console.error(`❌ [Job ${job?.id}] WayneRing sync task failed:`, err.message);
});

// Register the repeatable poll job once. BullMQ dedupes repeatable jobs by
// jobId, so this is safe to run on every worker process boot — it won't
// create duplicate schedules across restarts or multiple worker instances.
wayneRingSyncQueue.add('poll-calls', {}, {
  repeat: { every: POLL_INTERVAL_MS },
  jobId: 'wayne-ring-poll',
}).catch((err) => console.error('[WayneRing Sync] Failed to register repeatable poll job:', err.message));

module.exports = wayneRingCallSyncWorker;
