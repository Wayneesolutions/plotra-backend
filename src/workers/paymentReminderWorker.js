// src/workers/paymentReminderWorker.js
//
// Daily reminder + service-restriction cycle for the agent payment system
// (PR 2). Same repeatable-BullMQ-job pattern as wayneRingCallSyncWorker.js
// — registered once on module load, deduped by jobId across restarts, no
// separate cron dependency needed.
const { Worker, Queue } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { enqueueAgentWhatsappSend } = require('../services/agentMessagingService');
const { getCycleAnchorDate, daysSinceCycleAnchor } = require('../services/agentPaymentService');
const { trialStep, trialReminderMessage, trialExpiredMessage } = require('../services/trialService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

// Cycle-day thresholds, per spec: "day 28 se reminder... har 2 din pe
// repeat... month-end + 5 din tak bhi unpaid -> can_add_listing = false".
// Month treated as 30 days (matches the +1 month cycle-reset convention
// used elsewhere — see agentPaymentService.js's getCycleAnchorDate).
const REMINDER_START_DAY = 28;
const REMINDER_INTERVAL_DAYS = 2;
const RESTRICTION_DAY = 35; // 30 (month-end) + 5 (grace)

const paymentReminderQueue = new Queue('payment-reminder-cycle', { connection: redisConnection });

console.log(`[Worker Engine] Initializing Payment Reminder/Restriction Cycle...`);

/**
 * One pass over every agent — exported separately from the Worker handler
 * so it's testable/callable directly (e.g. a manual admin-triggered re-run)
 * without going through BullMQ.
 */
async function approvedPayerIds(userIds) {
  if (!userIds.length) return new Set();
  const rows = await knex('payment_submissions').whereIn('agent_id', userIds).where({ status: 'approved' }).distinct('agent_id');
  return new Set(rows.map((r) => r.agent_id));
}

/**
 * New dealers' 7-day free trial (trialService.js). Runs hourly so the trial
 * ends close to the hour it was granted. Reminders when 2 and 1 days are
 * left (once each, tracked in trial_reminder_day), then on expiry new
 * listings stop for the dealer and their sub-dealers.
 */
async function processTrialCycle(now = new Date()) {
  const users = await knex('users').whereNotNull('trial_ends_at');
  const paid = await approvedPayerIds(users.map((u) => u.id));
  let reminders = 0; let expired = 0;
  for (const user of users) {
    const step = trialStep(user, { hasApprovedPayment: paid.has(user.id), now });
    if (step.type === 'remind') {
      await knex('users').where({ id: user.id }).update({ trial_reminder_day: step.daysLeft, updated_at: knex.fn.now() });
      await enqueueAgentWhatsappSend({ tenantId: user.tenant_id, phone: user.phone, messageBody: trialReminderMessage(step.daysLeft) });
      reminders++;
    } else if (step.type === 'expire') {
      await knex('users').where({ id: user.id }).update({ can_add_listing: false, trial_reminder_day: 0, updated_at: knex.fn.now() });
      await enqueueAgentWhatsappSend({ tenantId: user.tenant_id, phone: user.phone, messageBody: trialExpiredMessage() });
      expired++;
    }
  }
  return { trialUsers: users.length, reminders, expired };
}

async function processReminderCycle() {
  // Dealers (owner) and the older WhatsApp agents both pay monthly; sub-dealers
  // without a package of their own are skipped below (no package_id).
  const agents = await knex('users').whereIn('role', ['agent', 'owner']);
  const paid = await approvedPayerIds(agents.filter((a) => a.trial_ends_at).map((a) => a.id));
  let remindersSent = 0;
  let restrictionsApplied = 0;
  let restrictionsLifted = 0;

  for (const agent of agents) {
    // Still in (or just out of) the free trial with no payment yet: the
    // trial cycle owns them. Without this the "drift" fix below would
    // switch listings back on for a dealer whose trial has ended.
    if (agent.trial_ends_at && !paid.has(agent.id)) continue;

    // No package chosen yet — nothing to remind/restrict about. Payment
    // is opt-in at onboarding (spec: "onboarding block nahi hoga"); an
    // agent who never picked a package never entered a billing cycle.
    if (!agent.package_id) continue;

    const anchor = await getCycleAnchorDate(knex, agent.id, agent.onboarded_at);
    const dayCount = daysSinceCycleAnchor(anchor);

    const shouldBeRestricted = dayCount >= RESTRICTION_DAY;

    if (shouldBeRestricted) {
      if (agent.can_add_listing) {
        await knex('users').where({ id: agent.id }).update({ can_add_listing: false, updated_at: knex.fn.now() });
        restrictionsApplied++;
        await enqueueAgentWhatsappSend({
          tenantId: agent.tenant_id,
          phone: agent.phone,
          messageBody: '⛔ Your monthly payment is overdue — new listings are paused until payment is confirmed. Your existing listings stay active and untouched. Reply "payment" once you\'ve paid to submit your receipt.',
        });
      }
      continue; // restriction message takes over — don't also send a reminder this run
    }

    // Safety net: if something restricted an agent (e.g. a manual DB
    // change, or a prior run's edge case) but they're now within a fresh
    // cycle, lift it. The normal path is approvePaymentSubmission already
    // doing this at approval time — this only catches drift.
    if (!agent.can_add_listing) {
      await knex('users').where({ id: agent.id }).update({ can_add_listing: true, updated_at: knex.fn.now() });
      restrictionsLifted++;
    }

    const isReminderDay = dayCount >= REMINDER_START_DAY && (dayCount - REMINDER_START_DAY) % REMINDER_INTERVAL_DAYS === 0;
    if (!isReminderDay) continue;

    const messageBody = agent.payment_status === 'pending_review'
      ? 'Your payment receipt is still being reviewed — no action needed from you right now.'
      : `⏰ Your monthly payment is due soon (day ${dayCount} of your cycle). Please complete your payment and reply "payment" to submit your receipt photo.`;

    await enqueueAgentWhatsappSend({ tenantId: agent.tenant_id, phone: agent.phone, messageBody });
    remindersSent++;
  }

  return { agentsChecked: agents.length, remindersSent, restrictionsApplied, restrictionsLifted };
}

const paymentReminderWorker = new Worker('payment-reminder-cycle', async (job) => {
  if (job.name === 'trial-check') {
    const result = await processTrialCycle();
    console.log(`[Job ${job.id}] Trial cycle: ${JSON.stringify(result)}`);
    return { success: true, ...result };
  }
  if (job.name !== 'daily-check') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on payment-reminder-cycle, skipping.`);
    return { success: false, skipped: true };
  }

  try {
    const result = await processReminderCycle();
    console.log(`[Job ${job.id}] Payment reminder cycle: ${JSON.stringify(result)}`);
    return { success: true, ...result };
  } catch (error) {
    console.error(`[Job ${job.id}] Payment reminder cycle failed:`, error.message);
    throw error; // let BullMQ retry — this is a repeatable job, next scheduled tick will also run regardless
  }
}, { connection: redisConnection });

paymentReminderWorker.on('failed', (job, err) => {
  console.error(`❌ [Job ${job?.id}] Payment reminder cycle task failed:`, err.message);
});

// Once daily at 09:00 server time. Registered on every worker process
// boot — BullMQ dedupes repeatable jobs by jobId, so this is safe across
// restarts/multiple instances, same as wayneRingCallSyncWorker.js.
paymentReminderQueue.add('daily-check', {}, {
  repeat: { pattern: '0 9 * * *' },
  jobId: 'payment-reminder-daily',
}).catch((err) => console.error('[Payment Reminder] Failed to register repeatable job:', err.message));

// Trial reminders/expiry: hourly, so a trial ends within the hour it should.
paymentReminderQueue.add('trial-check', {}, {
  repeat: { pattern: '7 * * * *' },
  jobId: 'trial-check-hourly',
}).catch((err) => console.error('[Payment Reminder] Failed to register trial job:', err.message));

module.exports = paymentReminderWorker;
module.exports.processTrialCycle = processTrialCycle;
