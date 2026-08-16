// src/workers/wayneRingCallSyncWorker.js
//
// WayneRing sends no outbound webhook — this is the only way Plotra learns
// a call actually happened and how it went. Runs as a repeatable BullMQ job
// (registered once below, on module load) rather than reacting to an event,
// because there is no event to react to.
const { Worker, Queue } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { listCalls, listInboundCalls } = require('../services/wayneRingService');
const { normalizePhone } = require('../utils/phone');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

const POLL_INTERVAL_MS = Number(process.env.WAYNERING_POLL_INTERVAL_MS) || 120000; // 2 min default — balance between timely outcomes and not hammering WayneRing's API
const MATCH_WINDOW_HOURS = 6; // how long after an outbound call was triggered we'll still consider a WayneRing record a match

const wayneRingSyncQueue = new Queue('wayne-ring-sync', { connection: redisConnection });

console.log(`[Worker Engine] Initializing WayneRing Call Sync Poller...`);

/**
 * Matches pending outbound anchor rows (pre-inserted by
 * wayneRingService.uploadLeadAndStartCampaign at trigger time — see that
 * file for why an anchor exists at all) against WayneRing's call list by
 * phone number + a time window after the anchor was created. This is a
 * real correlation, not a guess: Plotra initiated the call and knows the
 * phone+timestamp, it just doesn't get a synchronous call id back.
 */
async function syncOutboundCalls() {
  const pendingAnchors = await knex('ai_voice_calls as c')
    .join('leads as ld', 'c.lead_id', 'ld.id')
    .select('c.id', 'c.called_at', 'ld.phone')
    .where({ 'c.provider': 'wayneRing', 'c.direction': 'outbound' })
    .whereNull('c.synced_at');

  if (pendingAnchors.length === 0) return { matched: 0, pending: 0 };

  const calls = await listCalls();
  let matched = 0;

  for (const anchor of pendingAnchors) {
    const anchorPhone = normalizePhone(anchor.phone);
    const match = calls.find((call) => {
      const callPhone = normalizePhone(call.phone || call.leadPhone || call.to);
      if (!callPhone || callPhone !== anchorPhone) return false;
      const callTime = new Date(call.calledAt || call.createdAt || call.startedAt);
      const anchorTime = new Date(anchor.called_at);
      if (Number.isNaN(callTime.getTime())) return false;
      const diffMs = callTime.getTime() - anchorTime.getTime();
      // small negative allowance for clock skew between the two systems
      return diffMs >= -60000 && diffMs <= MATCH_WINDOW_HOURS * 3600 * 1000;
    });

    if (!match) continue;

    await knex('ai_voice_calls').where({ id: anchor.id }).update({
      outcome: match.outcome || null,
      duration_seconds: match.durationSeconds ?? match.duration_seconds ?? null,
      recording_url: match.recordingUrl || match.recording_url || null,
      transcript_summary: match.summary || match.transcript_summary || null,
      provider_call_id: String(match.id),
      correlation_method: 'anchor_match',
      synced_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
    matched++;
  }

  return { matched, pending: pendingAnchors.length - matched };
}

/**
 * WayneRing has no concept of Plotra tenants/leads at all — an inbound call
 * only reaches Plotra's DB by resolving which dealer's forwarded number it
 * came in on (tenant_configs.wayne_ring_inbound_number_id), then matching/
 * creating a lead by the caller's phone. If the number can't be resolved to
 * a tenant, the call is NOT silently dropped — it's recorded in
 * wayne_ring_unmatched_calls for manual reconciliation, since ai_voice_calls
 * structurally requires a tenant_id (correctly, for every other row in it).
 */
async function syncInboundCalls() {
  const calls = await listInboundCalls();
  let created = 0;
  let unmatched = 0;
  let alreadyKnown = 0;

  for (const call of calls) {
    const providerCallId = String(call.id);

    const existing = await knex('ai_voice_calls').where({ provider_call_id: providerCallId }).first();
    if (existing) { alreadyKnown++; continue; }
    const existingUnmatched = await knex('wayne_ring_unmatched_calls').where({ provider_call_id: providerCallId }).first();
    if (existingUnmatched) { alreadyKnown++; continue; }

    const calledNumberId = call.phoneNumberId || call.toNumberId || call.numberId || null;
    const tenantConfig = calledNumberId
      ? await knex('tenant_configs').where({ wayne_ring_inbound_number_id: calledNumberId }).first()
      : null;

    const callerPhoneRaw = call.callerPhone || call.from || call.phone;

    if (!tenantConfig) {
      await knex('wayne_ring_unmatched_calls').insert({
        provider_call_id: providerCallId,
        caller_phone: callerPhoneRaw ? normalizePhone(callerPhoneRaw) : null,
        called_number_id: calledNumberId,
        raw_call_data: JSON.stringify(call),
        call_started_at: call.startedAt || call.createdAt || null,
      });
      unmatched++;
      continue;
    }

    const callerPhone = normalizePhone(callerPhoneRaw);
    let lead = await knex('leads').where({ tenant_id: tenantConfig.tenant_id, phone: callerPhone }).first();
    if (!lead) {
      [lead] = await knex('leads').insert({
        tenant_id: tenantConfig.tenant_id,
        phone: callerPhone,
        source: 'ai_call_inbound',
        status: 'new',
      }).returning(['id']);
    }

    await knex('ai_voice_calls').insert({
      tenant_id: tenantConfig.tenant_id,
      lead_id: lead.id,
      direction: 'inbound',
      provider: 'wayneRing',
      outcome: call.outcome || null,
      duration_seconds: call.durationSeconds ?? call.duration_seconds ?? null,
      recording_url: call.recordingUrl || call.recording_url || null,
      transcript_summary: call.summary || call.transcript_summary || null,
      called_at: call.startedAt || call.createdAt || knex.fn.now(),
      provider_call_id: providerCallId,
      correlation_method: 'phone_time_match',
      synced_at: knex.fn.now(),
    });
    created++;
  }

  return { created, unmatched, alreadyKnown };
}

const wayneRingCallSyncWorker = new Worker('wayne-ring-sync', async (job) => {
  if (job.name !== 'poll-calls') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on wayne-ring-sync, skipping.`);
    return { success: false, skipped: true };
  }

  try {
    const outboundResult = await syncOutboundCalls();
    const inboundResult = await syncInboundCalls();
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
