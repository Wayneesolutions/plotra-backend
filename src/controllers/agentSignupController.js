// src/controllers/agentSignupController.js
//
// Agent self-registration — a prospective agent texts "join as agent" to a
// Plotra WhatsApp number and, once the owner approves, their phone is
// immediately live for the existing agent-intake flow
// (agentIntakeController.js). Deliberately a separate module/table/queue
// from both agentIntakeController.js (dealer listing intake, for already-
// registered agents) and webhookController.js's buyer/lead path — neither
// of those is touched by this file.
//
// Two halves live here:
//   1. handleAgentSignupMessage — called from webhookController.js for an
//      inbound WhatsApp sender that doesn't match a known agent, BEFORE
//      the buyer/lead path runs. Claims the message (returns true, and has
//      already responded) if it's a "join as agent" trigger or a
//      continuation of an in-progress signup conversation; otherwise
//      returns false untouched so the caller falls through to the
//      existing buyer path.
//   2. listAgentSignups / approveAgentSignup / rejectAgentSignup — the
//      tenant-dashboard endpoints (owner-only) that review what this
//      collects.
const { Queue } = require('bullmq');
const { normalizePhone } = require('../utils/phone');
const { detectReplyLanguage } = require('../utils/replyLanguage');
const { enqueueAgentWhatsappSend } = require('../services/agentMessagingService');
const { sendPackageSelectionPrompt } = require('../services/agentPaymentService');
const { CityValidationError } = require('../services/tenantCityService');
const { resolveTenantForSignup } = require('../services/agentSignupService');
const { createDealerFromSignup, buildDealerWelcomeMessage, shortDate } = require('../services/dealerOnboardingService');
const { buildTemplate } = require('../services/whatsappTemplates');
const { variantFor } = require('../utils/i18n');
// Lazy: assistantService pulls in the messaging queue; keeps this file's
// load order unchanged.
const handleWithAssistant = (...a) => require('../services/assistantService').handleWithAssistant(...a);

// Same fail-fast producer config used throughout (webhookController.js,
// agentIntakeController.js) — called from an inbound webhook request, not
// a worker, so a Redis blip should fail fast rather than hang the caller.
const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 5000),
  connectTimeout: 3000,
};
const agentSignupQueue = new Queue('agent-signup-intake', { connection: redisConnection });

// Same debounce rationale as agentIntakeController.js's EXTRACT_DEBOUNCE_MS —
// a cost optimization only; agentSignupWorker.js always re-reads the
// signup's current accumulated_text at execution time.
const EXTRACT_DEBOUNCE_MS = 7000;

// Trigger phrases that start the agent self-registration flow. Substring-
// matched against the incoming message (same pattern as isNewListingIntent
// in agentReplyIntent.js). Kept deliberately conservative — false positives
// here would intercept genuine buyer messages. Extend the list as real-world
// missed phrases come in from support.
const SIGNUP_TRIGGER_PATTERNS = [
  // English — join / become / sign up
  /\bjoin\s+as\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\bbecome\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\bsign\s*(?:me\s*)?up\s+as\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\bi\s+want\s+to\s+(?:be|become)\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  // English — add me / add as
  /\badd\s+me\s+as\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\badd\s+(?:me\s+)?as\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\badd\s+(?:me\s+)?(?:as\s+)?(?:an?\s+)?agent\b/i,
  // English — register
  /\bregister\s+(?:me\s+)?as\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\bregister\s+(?:me\s+)?(?:as\s+)?(?:an?\s+)?agent\b/i,
  // Hindi / Hinglish
  /\bnaya\s+agent\b/i,
  /\bnayi\s+agent\b/i,
  /\bagent\s+banna\b/i,
  /\bdealer\s+banna\b/i,
  /\bagent\s+banana\b/i,
  /\bmujhe\s+agent\b/i,
  /\bagent\s+(?:mein|me)\s+add\b/i,
  /\bagent\s+ban\s+(?:na\s+)?chahta\b/i,
  /\bagent\s+ban\s+(?:na\s+)?chahti\b/i,
];

async function enqueueSignupExtractJob(signupId) {
  const jobId = `signup-extract-${signupId}`;
  try {
    // Same stale-job cleanup as agentIntakeController.js's enqueueExtractJob
    // — BullMQ blocks duplicate jobIds regardless of state, so a previously
    // failed extraction would otherwise permanently block retries.
    const existing = await agentSignupQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') await existing.remove();
    }
    await agentSignupQueue.add('extract', { signupId }, {
      delay: EXTRACT_DEBOUNCE_MS,
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } catch (err) {
    console.log(`[agentSignup] extract job for signup ${signupId} already scheduled:`, err.message);
  }
}

// resolveTenantForSignup lives in agentSignupService.js (shared with the
// conversational joining flow).

/**
 * Sent the moment an agent is approved: what to do first, in their language.
 * `credentials` only on the super-admin path (the owner path shows them to
 * the owner instead). The package menu follows as a separate message.
 */
function buildAgentWelcomeMessage({ name, lang, credentials }) {
  const login = credentials
    ? (lang === 'en'
        ? `\n\n*Dashboard login* (optional, at plotraa.com):\n📧 ${credentials.email}\n🔑 ${credentials.password}\nPlease change the password after your first login.`
        : `\n\n*Dashboard login* (zaroori nahi, plotraa.com pe):\n📧 ${credentials.email}\n🔑 ${credentials.password}\nPehli baar login karke password badal lena.`)
    : '';
  return lang === 'en'
    ? `✅ *Welcome to Plotraa, ${name}!* Your agent account is approved.\n\n*Your first listing, in 3 steps:*\n1. Send the property details here: area, type, size, price (text or a voice note 🎤)\n2. Share the exact location 📍 when asked\n3. Check the preview link and reply *"yes"* to publish\n\nNext, choose your plan from the message below. Any question, just ask here in your own words.${login}`
    : `✅ *Plotraa mein swagat hai, ${name} ji!* Aapka agent account approve ho gaya hai.\n\n*Pehli listing, 3 steps mein:*\n1. Property ki details yahan bhejo: area, type, size, price (likh ke ya voice note 🎤)\n2. Pucchne pe exact location 📍 share karo\n3. Preview link check karke *"haan"* reply karo, listing live\n\nAb neeche wale message se apna plan chun lo. Koi bhi sawaal ho, yahin apne shabdon mein pooch lo.${login}`;
}

function buildStillPendingMessage(lang) {
  return lang === 'en'
    ? "Thanks — your request to join as an agent is still awaiting approval from the team. We'll let you know as soon as it's reviewed."
    : "Dhanyavaad — aapka agent banne ka request abhi bhi team ke approval ka wait kar raha hai. Review hote hi bata denge.";
}

/**
 * Entry point called from webhookController.js when an inbound sender's
 * phone doesn't match a known agent. Returns false (no response sent) if
 * this message isn't signup-related at all — the caller falls through to
 * the existing buyer path. Otherwise handles the message fully (including
 * sending the HTTP response) and returns true.
 */
async function handleAgentSignupMessage({ knex, phone, leadName, incomingText, receivingPhoneNumberId, receivingNumber, res }) {
  const isTrigger = SIGNUP_TRIGGER_PATTERNS.some((re) => re.test(incomingText));
  const normalizedPhone = normalizePhone(phone);

  const tenant = await resolveTenantForSignup(knex, { receivingPhoneNumberId, receivingNumber });
  if (!tenant) return false; // nothing to attribute this to — let the buyer path's own handling take it

  const existingSignup = await knex('pending_agent_signups')
    .where({ tenant_id: tenant.id, phone: normalizedPhone, status: 'pending' })
    .first();

  if (!isTrigger && !existingSignup) return false; // not a signup conversation

  // Conversational joining (assistantService.js + agentSignupService.js):
  // answers questions asked mid-signup, collects name/area from whatever
  // they say, and tells them exactly what's still needed. The step-by-step
  // path below is only the fallback when the assistant is unavailable.
  const assistantReply = await handleWithAssistant(knex, {
    audience: 'visitor',
    phone: normalizedPhone,
    name: leadName && leadName !== 'Visitor' ? leadName : null,
    text: incomingText,
    receiving: { receivingPhoneNumberId, receivingNumber },
    startSignup: isTrigger,
  });
  if (assistantReply.handled) {
    res.status(200).json({ success: true, assistant: assistantReply.action });
    return true;
  }

  try {
    if (existingSignup && existingSignup.name && existingSignup.address) {
      // Already fully collected and sitting with the owner for a decision —
      // don't re-run extraction on a top-up message, just remind them
      // (same lesson as agentIntakeController.js's awaiting_approval fix:
      // don't silently re-process a message that isn't actually new info).
      const replyBody = buildStillPendingMessage(detectReplyLanguage(incomingText));
      await enqueueAgentWhatsappSend({ tenantId: tenant.id, phone: normalizedPhone, messageBody: replyBody });
    } else {
      let signupId;

      await knex.transaction(async (trx) => {
        let signup = existingSignup
          ? await trx('pending_agent_signups').where({ id: existingSignup.id }).forUpdate().first()
          : null;

        if (!signup) {
          // WhatsApp's own contact profile name is usually available and
          // saves asking for it explicitly; 'Visitor' is parseInboundPayload's
          // generic fallback when no profile name exists, not a real name,
          // so it's never seeded as one.
          const seedName = leadName && leadName !== 'Visitor' ? leadName : null;
          [signup] = await trx('pending_agent_signups').insert({
            tenant_id: tenant.id,
            phone: normalizedPhone,
            name: seedName,
            accumulated_text: incomingText,
          }).returning(['id']);
        } else {
          await trx('pending_agent_signups')
            .where({ id: signup.id })
            .update({
              accumulated_text: trx.raw(`TRIM(accumulated_text || ' ' || ?)`, [incomingText]),
              updated_at: trx.fn.now(),
            });
        }

        signupId = signup.id;
      });

      await enqueueSignupExtractJob(signupId);
    }
  } catch (error) {
    console.error('Failed to process agent self-registration message:', error.message);
    // Fall through to the ack below regardless — same rationale as every
    // other webhook handler in this codebase: still ack 200 so the BSP
    // doesn't retry-storm us.
  }

  res.status(200).json({ success: true });
  return true;
}

// ---- Dealer dashboard (old owner-side review) ------------------------------
//
// Everyone who joins on WhatsApp is a new DEALER now (own tenant + panel),
// approved only by the Plotraa team in Admin -> Agent Signups. A dealer adds
// their own sub-dealers from Team -> Invite, so these dashboard endpoints no
// longer approve anyone: the list is always empty and approve/reject explain
// why, so an old frontend build can't turn a new dealer into someone's agent.

const OWNER_REVIEW_GONE = 'New dealers who join on WhatsApp are approved by the Plotraa team. Add your own sub-dealers from Team -> Invite.';

/** GET /api/v1/dashboard/agent-signups */
async function listAgentSignups(req, res) {
  return res.status(200).json({ success: true, signups: [], message: OWNER_REVIEW_GONE });
}

/** POST /api/v1/dashboard/agent-signups/:id/approve */
async function approveAgentSignup(req, res) {
  return res.status(403).json({ error: { code: 'APPROVED_BY_PLOTRAA', message: OWNER_REVIEW_GONE } });
}

/** POST /api/v1/dashboard/agent-signups/:id/reject */
async function rejectAgentSignup(req, res) {
  return res.status(403).json({ error: { code: 'APPROVED_BY_PLOTRAA', message: OWNER_REVIEW_GONE } });
}

/**
 * GET /api/v1/admin/agent-signups
 * Super-admin view — all pending signups across every tenant.
 */
async function listAgentSignupsAdmin(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  try {
    const signups = await knex('pending_agent_signups as s')
      .leftJoin('tenants as t', 't.id', 's.tenant_id')
      .where({ 's.status': 'pending' })
      .whereNotNull('s.name')
      .whereNotNull('s.address')
      .select(
        's.id', 's.name', 's.phone', 's.address', 's.status', 's.created_at',
        's.tenant_id', 't.business_name as tenant_name'
      )
      .orderBy('s.created_at', 'desc');

    return res.status(200).json({ success: true, signups });
  } catch (error) {
    console.error('Failed to list agent signups (admin):', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load agent signup requests.' } });
  }
}

/**
 * POST /api/v1/admin/agent-signups/:id/approve
 * Body (optional): { city_ids, primary_city_id, business_name }
 *
 * Super-admin approval: the joiner becomes a NEW DEALER — their own tenant,
 * a users row with role 'owner' (their admin panel), and a 7-day free trial.
 * The WhatsApp welcome carries a one-time set-password link, never a
 * password. Cities: as picked, else the city named in their working area,
 * else the launch city.
 */
async function approveAgentSignupAdmin(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const body = req.body || {};
  try {
    const signup = await knex('pending_agent_signups').where({ id }).first();
    if (!signup) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Signup request not found.' } });
    if (signup.status !== 'pending') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: `Request is already ${signup.status}.` } });
    }

    const { tenant, user, setupUrl, trialEndsAt } = await createDealerFromSignup(knex, signup, {
      cityIds: body.city_ids,
      primaryCityId: body.primary_city_id,
      businessName: body.business_name,
    });

    const welcome = buildDealerWelcomeMessage({
      name: signup.name,
      lang: detectReplyLanguage(signup.accumulated_text),
      phone: user.phone,
      setupUrl,
      trialEnd: trialEndsAt,
    });
    try {
      await enqueueAgentWhatsappSend({
        tenantId: tenant.id,
        phone: user.phone,
        messageBody: welcome,
        // The new dealer usually has not messaged us in the last 24 hours, so
        // the welcome + set-password link goes as a template then.
        template: buildTemplate('dealer_welcome', {
          name: signup.name,
          trial_end_date: shortDate(trialEndsAt),
          login_id: user.phone,
          set_password_link: setupUrl,
        }),
      });
    } catch (err) {
      console.error('Failed to send dealer welcome (non-fatal):', err.message);
    }
    try {
      await sendPackageSelectionPrompt(knex, { tenantId: tenant.id, phone: user.phone, v: variantFor(signup.accumulated_text || '') });
    } catch (err) {
      console.error('Failed to send package selection prompt (non-fatal):', err.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Dealer approved — their own account is created and the welcome with a set-password link was sent on WhatsApp.',
      tenant,
      user,
      trialEndsAt,
      // Shown to the admin as a fallback if WhatsApp delivery fails; it's a
      // one-time link, not a password.
      setupUrl,
    });
  } catch (error) {
    if (error instanceof CityValidationError) {
      return res.status(error.status || 400).json({ error: { code: error.code, message: error.message } });
    }
    if (error.code === 'DUPLICATE_PHONE' || error.code === '23505') {
      return res.status(409).json({ error: { code: 'DUPLICATE_ENTRY', message: 'This phone number already has an account.' } });
    }
    console.error('Failed to approve agent signup (admin):', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve this signup request.' } });
  }
}

/**
 * POST /api/v1/admin/agent-signups/:id/reject
 * Super-admin rejection — notifies the applicant via WhatsApp.
 */
async function rejectAgentSignupAdmin(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  try {
    const signup = await knex('pending_agent_signups').where({ id }).first();
    if (!signup) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Signup request not found.' } });
    if (signup.status !== 'pending') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: `Request is already ${signup.status}.` } });
    }

    await knex('pending_agent_signups').where({ id }).update({ status: 'rejected', updated_at: knex.fn.now() });

    const rejectionMessage =
      `We've reviewed your request to join as a Plotraa agent and are unable to approve it at this time. ` +
      `If you have questions, please reply to this message.`;

    await enqueueAgentWhatsappSend({ tenantId: signup.tenant_id, phone: normalizePhone(signup.phone), messageBody: rejectionMessage });

    return res.status(200).json({ success: true, message: 'Signup request rejected — applicant notified.' });
  } catch (error) {
    console.error('Failed to reject agent signup (admin):', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject this signup request.' } });
  }
}

module.exports = {
  buildAgentWelcomeMessage,
  handleAgentSignupMessage,
  listAgentSignups,
  approveAgentSignup,
  rejectAgentSignup,
  listAgentSignupsAdmin,
  approveAgentSignupAdmin,
  rejectAgentSignupAdmin,
};
