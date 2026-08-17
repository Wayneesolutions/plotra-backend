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

const wayneRingCallSyncWorker = new Worker('wayne-ring-sync', async (job) => {
  if (job.name !== 'poll-calls') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on wayne-ring-sync, skipping.`);
    return { success: false, skipped: true };
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
