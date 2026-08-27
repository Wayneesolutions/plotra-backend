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
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { normalizePhone } = require('../utils/phone');
const { detectReplyLanguage } = require('../utils/replyLanguage');
const { enqueueAgentWhatsappSend } = require('../services/agentMessagingService');

// Same fail-fast producer config used throughout (webhookController.js,
// agentIntakeController.js) — called from an inbound webhook request, not
// a worker, so a Redis blip should fail fast rather than hang the caller.
const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  connectTimeout: 3000,
};
const agentSignupQueue = new Queue('agent-signup-intake', { connection: redisConnection });

// Same debounce rationale as agentIntakeController.js's EXTRACT_DEBOUNCE_MS —
// a cost optimization only; agentSignupWorker.js always re-reads the
// signup's current accumulated_text at execution time.
const EXTRACT_DEBOUNCE_MS = 7000;

// "join as agent" / "join as an agent" — case-insensitive trigger phrase.
const SIGNUP_KEYWORD_RE = /\bjoin\s+as\s+(?:an?\s+)?agent\b/i;

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

/**
 * Independent copy of webhookController.js's buyer-path tenant resolution
 * (phone_number_id -> whatsapp_number -> oldest-active-tenant fallback).
 * Deliberately NOT extracted/shared from that file — the buyer path stays
 * completely untouched, at the cost of this small duplication.
 */
async function resolveTenantForSignup(knex, { receivingPhoneNumberId, receivingNumber }) {
  let tenant = null;

  if (receivingPhoneNumberId) {
    tenant = await knex('tenants').where({ phone_number_id: receivingPhoneNumberId, status: 'active' }).first();
  }
  if (!tenant && receivingNumber) {
    tenant = await knex('tenants').where({ whatsapp_number: receivingNumber, status: 'active' }).first();
  }
  if (!tenant) {
    tenant = await knex('tenants').where({ status: 'active' }).orderBy('created_at', 'asc').first();
  }
  return tenant;
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
  const isTrigger = SIGNUP_KEYWORD_RE.test(incomingText);
  const normalizedPhone = normalizePhone(phone);

  const tenant = await resolveTenantForSignup(knex, { receivingPhoneNumberId, receivingNumber });
  if (!tenant) return false; // nothing to attribute this to — let the buyer path's own handling take it

  const existingSignup = await knex('pending_agent_signups')
    .where({ tenant_id: tenant.id, phone: normalizedPhone, status: 'pending' })
    .first();

  if (!isTrigger && !existingSignup) return false; // not a signup conversation

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

/**
 * GET /api/v1/dashboard/agent-signups
 * Lists this tenant's pending, fully-collected signup requests — a row
 * whose conversational collection isn't finished yet (name/address still
 * null) deliberately doesn't show up here yet; see the migration's comment.
 */
async function listAgentSignups(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;

  if (role !== 'owner') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only tenant owners can view agent signup requests.' }
    });
  }

  try {
    const signups = await knex('pending_agent_signups')
      .where({ tenant_id, status: 'pending' })
      .whereNotNull('name')
      .whereNotNull('address')
      .select('id', 'name', 'phone', 'address', 'status', 'created_at')
      .orderBy('created_at', 'desc');

    return res.status(200).json({ success: true, signups });
  } catch (error) {
    console.error('Failed to list agent signups:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load agent signup requests.' }
    });
  }
}

/**
 * POST /api/v1/dashboard/agent-signups/:id/approve
 * Creates the real users row for this phone (role='agent') — no separate
 * activation step, the phone is immediately recognized by
 * agentIntakeController.js's agent-intake routing the moment this commits.
 *
 * No email was ever collected over WhatsApp, but users.email is NOT NULL +
 * UNIQUE, so a placeholder is synthesized from the (already-unique) phone
 * number. A temporary password is generated too, same as
 * userInviteController.js's invite flow, in case the owner wants to also
 * hand this agent dashboard login access — returned in the response for
 * the owner to share directly, exactly like InviteUserModal.jsx's
 * credential display.
 */
async function approveAgentSignup(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const { id } = req.params;

  if (role !== 'owner') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only tenant owners can approve agent signup requests.' }
    });
  }

  try {
    const signup = await knex('pending_agent_signups').where({ id, tenant_id }).first();
    if (!signup) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Signup request not found.' } });
    }
    if (signup.status !== 'pending') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: `Request is already ${signup.status}.` }
      });
    }

    const normalizedPhone = normalizePhone(signup.phone);
    const tempPassword = `Welcome${crypto.randomBytes(4).toString('hex')}!`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const placeholderEmail = `agent.${normalizedPhone.replace(/\D/g, '')}@wa-signup.plotra.internal`;

    let newUser;
    await knex.transaction(async (trx) => {
      [newUser] = await trx('users').insert({
        tenant_id,
        name: signup.name,
        email: placeholderEmail,
        password_hash: hashedPassword,
        role: 'agent',
        phone: normalizedPhone,
      }).returning(['id', 'name', 'email', 'phone', 'role']);

      await trx('pending_agent_signups')
        .where({ id })
        .update({ status: 'approved', updated_at: trx.fn.now() });
    });

    return res.status(200).json({
      success: true,
      message: 'Agent approved — their WhatsApp number is now live for listing intake.',
      user: newUser,
      temporaryPassword: tempPassword,
    });
  } catch (error) {
    if (error.code === '23505') { // unique_violation — phone already registered to someone else
      return res.status(409).json({
        error: { code: 'DUPLICATE_ENTRY', message: 'This phone number is already registered to another account.' }
      });
    }
    console.error('Failed to approve agent signup:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to approve this signup request.' }
    });
  }
}

/**
 * POST /api/v1/dashboard/agent-signups/:id/reject
 */
async function rejectAgentSignup(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const { id } = req.params;

  if (role !== 'owner') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only tenant owners can reject agent signup requests.' }
    });
  }

  try {
    const signup = await knex('pending_agent_signups').where({ id, tenant_id }).first();
    if (!signup) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Signup request not found.' } });
    }
    if (signup.status !== 'pending') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: `Request is already ${signup.status}.` }
      });
    }

    await knex('pending_agent_signups')
      .where({ id })
      .update({ status: 'rejected', updated_at: knex.fn.now() });

    return res.status(200).json({ success: true, message: 'Signup request rejected.' });
  } catch (error) {
    console.error('Failed to reject agent signup:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reject this signup request.' }
    });
  }
}

module.exports = {
  handleAgentSignupMessage,
  listAgentSignups,
  approveAgentSignup,
  rejectAgentSignup,
};
