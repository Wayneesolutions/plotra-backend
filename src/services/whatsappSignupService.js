// src/services/whatsappSignupService.js
//
// Part 3 — WhatsApp self-serve onboarding for Tier 1. A prospect messages
// Plotra's dedicated onboarding number directly; this drives the multi-
// turn conversation (name -> area -> number -> confirm) and, once
// confirmed, creates a tenant_requests row so the existing admin
// approve/reject review picks it up — no parallel review system.
//
// Entry point classification lives in webhookController.js: a message is
// routed here only when it arrived on WHATSAPP_ONBOARDING_NUMBER /
// WHATSAPP_ONBOARDING_PHONE_NUMBER_ID, or the sender already has an
// in-progress session (so replies keep working even if a later message
// somehow reports the receiving number differently). This is a distinct
// number from WHATSAPP_SHARED_NUMBER (the existing shared-buyer-routing
// number several tenants can share) specifically so this flow can never
// collide with that unrelated existing feature.

const { normalizePhone } = require('../utils/phone');
const { isApprovalReply } = require('../utils/agentReplyIntent');

const WELCOME_MESSAGE = "👋 Welcome to Plotra! Let's get you set up to list properties over WhatsApp.\n\nWhat's your name?";

async function hasActiveSignupSession(knex, phone) {
  const session = await knex('whatsapp_signup_sessions')
    .where({ phone: normalizePhone(phone) })
    .whereNotIn('state', ['completed', 'abandoned'])
    .first();
  return !!session;
}

async function getOrCreateSession(knex, phone) {
  const normalized = normalizePhone(phone);
  let session = await knex('whatsapp_signup_sessions').where({ phone: normalized }).first();
  if (!session) {
    [session] = await knex('whatsapp_signup_sessions')
      .insert({ phone: normalized, state: 'new' })
      .returning('*');
  }
  return session;
}

/**
 * Advances the session by one turn and returns the WhatsApp reply text to
 * send back. Every branch either updates the session row or returns a
 * re-prompt — never both silently drops input and says nothing.
 */
async function advanceSession(knex, session, incomingText) {
  const text = String(incomingText || '').trim();

  switch (session.state) {
    case 'new': {
      await knex('whatsapp_signup_sessions')
        .where({ id: session.id })
        .update({ state: 'collecting_name', updated_at: knex.fn.now() });
      return WELCOME_MESSAGE;
    }

    case 'collecting_name': {
      if (!text) return "Please share your name to continue.";
      await knex('whatsapp_signup_sessions')
        .where({ id: session.id })
        .update({ collected_name: text, state: 'collecting_area', updated_at: knex.fn.now() });
      return `Nice to meet you, ${text}! Which area(s) do you deal in? (e.g. "Ludhiana, Mohali")`;
    }

    case 'collecting_area': {
      if (!text) return "Please share the area(s) you deal in to continue.";
      await knex('whatsapp_signup_sessions')
        .where({ id: session.id })
        .update({ collected_area: text, state: 'collecting_number', updated_at: knex.fn.now() });
      return "Got it. Which WhatsApp number should we activate for listing properties on Plotra? (10-digit number)";
    }

    case 'collecting_number': {
      const normalized = normalizePhone(text);
      const digitCount = (normalized || '').replace(/\D/g, '').length;
      if (!normalized || digitCount < 10) {
        return "That doesn't look like a valid number. Please share a 10-digit WhatsApp number.";
      }
      await knex('whatsapp_signup_sessions')
        .where({ id: session.id })
        .update({ collected_number: normalized, state: 'confirming', updated_at: knex.fn.now() });
      const s = await knex('whatsapp_signup_sessions').where({ id: session.id }).first();
      return `Please confirm:\n\nName: ${s.collected_name}\nArea: ${s.collected_area}\nNumber: ${normalized}\n\nReply YES to submit for review.`;
    }

    case 'confirming': {
      if (!isApprovalReply(text)) {
        return "Reply YES to submit your details for review, or message us again if something needs to change.";
      }

      const [request] = await knex('tenant_requests')
        .insert({
          // No separate business name is collected in this flow — the
          // contact's own name is a reasonable default for a solo,
          // WhatsApp-only dealer; the admin can edit it at approval time.
          business_name: session.collected_name,
          contact_name: session.collected_name,
          email: null, // never collected here — see the migration's relaxed NOT NULL
          phone: session.collected_number,
          message: `WhatsApp self-serve signup. Area: ${session.collected_area}`,
          source: 'whatsapp',
          requested_whatsapp_number: session.collected_number,
          requested_plan: process.env.WHATSAPP_SIGNUP_DEFAULT_PLAN || 'tier1',
        })
        .returning('*');

      await knex('whatsapp_signup_sessions')
        .where({ id: session.id })
        .update({ state: 'submitted', tenant_request_id: request.id, updated_at: knex.fn.now() });

      return "Thanks! Your request has been submitted for review. We'll message you here once it's approved.";
    }

    case 'submitted':
      return "Your request is still under review. We'll message you here once it's approved.";

    case 'awaiting_payment': {
      if (/\bcash\b/i.test(text)) {
        await knex('tenant_requests')
          .where({ id: session.tenant_request_id })
          .update({ payment_status: 'cash_pending', updated_at: knex.fn.now() });
        return "Got it — we've noted that you'll pay in cash. Our team will confirm shortly and activate your account.";
      }
      return "Please complete payment using the link we sent, or reply CASH if you've already paid in cash.";
    }

    case 'completed':
      return "You're all set! Text your property details here anytime to list them.";

    default:
      return "Sorry, something went wrong on our end. Please try again in a moment.";
  }
}

module.exports = { hasActiveSignupSession, getOrCreateSession, advanceSession, WELCOME_MESSAGE };
