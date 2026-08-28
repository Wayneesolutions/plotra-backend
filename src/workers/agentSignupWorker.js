// src/workers/agentSignupWorker.js
//
// Consumes queue 'agent-signup-intake' (job name 'extract') — the agent
// self-registration counterpart to agentIntakeWorker.js's listing
// extraction, but simpler: no listing/geocoding involved, just resolving
// {name, address} from the accumulated "join as agent" conversation and
// either asking a follow-up question or confirming the request is now
// sitting with the tenant owner for approval.
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { enqueueAgentWhatsappSend } = require('../services/agentMessagingService');
const {
  extractAgentSignupFields, REQUIRED_FIELDS, FIELD_QUESTIONS, FIELD_QUESTIONS_EN,
} = require('../services/agentSignupExtractionService');
const { detectReplyLanguage } = require('../utils/replyLanguage');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

console.log(`[Worker Engine] Initializing Agent Self-Registration Processor...`);

function fieldQuestionsFor(lang) {
  return lang === 'en' ? FIELD_QUESTIONS_EN : FIELD_QUESTIONS;
}

function buildPendingApprovalMessage(lang) {
  return lang === 'en'
    ? "Thanks! Your request to join as an agent has been submitted and is pending approval from the team. We'll let you know once it's reviewed."
    : "Dhanyavaad! Aapka agent banne ka request submit ho gaya hai aur team ke approval ka wait kar raha hai. Review hote hi bata denge.";
}

const agentSignupWorker = new Worker('agent-signup-intake', async (job) => {
  if (job.name !== 'extract') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on agent-signup-intake, skipping.`);
    return { success: false, skipped: true };
  }

  const { signupId } = job.data;
  console.log(`[Job ${job.id}] Extracting agent signup fields for ${signupId}`);

  const signup = await knex('pending_agent_signups').where({ id: signupId }).first();
  if (!signup || signup.status !== 'pending') {
    return { success: true, skipped: true }; // stale job — already decided (or somehow gone)
  }

  const lang = detectReplyLanguage(signup.accumulated_text);
  const extracted = await extractAgentSignupFields(signup.accumulated_text);

  // COALESCE-style merge — never let this pass's extraction blank out a
  // fact already resolved from an earlier message (or seeded from the
  // WhatsApp profile name at signup-detection time) just because this
  // particular message didn't repeat it.
  const merged = {
    name: extracted.name || signup.name,
    address: extracted.address || signup.address,
  };

  await knex('pending_agent_signups').where({ id: signupId }).update({
    name: merged.name,
    address: merged.address,
    updated_at: knex.fn.now(),
  });

  const missing = REQUIRED_FIELDS.filter((f) => !merged[f]);

  if (missing.length > 0) {
    const questions = fieldQuestionsFor(lang);
    const questionBody = missing.map((f) => questions[f]).join(' ');
    await enqueueAgentWhatsappSend({ tenantId: signup.tenant_id, phone: signup.phone, messageBody: questionBody });
    return { success: true, missing };
  }

  // Both fields now resolved for the first time — this row just became
  // visible in the owner's GET /api/v1/dashboard/agent-signups list.
  const confirmBody = buildPendingApprovalMessage(lang);
  await enqueueAgentWhatsappSend({ tenantId: signup.tenant_id, phone: signup.phone, messageBody: confirmBody });

  return { success: true, complete: true };
}, { connection: redisConnection });

agentSignupWorker.on('failed', async (job, err) => {
  console.error(`❌ [Job ${job?.id}] Agent signup task failed permanently:`, err.message);

  if (job?.name === 'extract' && job.attemptsMade >= job.opts.attempts) {
    const { signupId } = job.data;
    try {
      const signup = await knex('pending_agent_signups').where({ id: signupId }).first();
      if (!signup || signup.status !== 'pending') return;

      const lang = detectReplyLanguage(signup.accumulated_text);
      const body = lang === 'en'
        ? "Sorry, I couldn't understand that — please try again with your name and the area you work in."
        : "Samajh nahi paya, please dobara try karein — apna naam aur area/city zaroor batayein.";
      await enqueueAgentWhatsappSend({ tenantId: signup.tenant_id, phone: signup.phone, messageBody: body });
    } catch (notifyErr) {
      console.error(`[Job ${job?.id}] Failed to notify prospective agent of extraction failure:`, notifyErr.message);
    }
  }
});

module.exports = agentSignupWorker;
