// src/services/agentSignupService.js
//
// Conversational "join as a Plotraa agent". The Plotraa Assistant decides
// when someone wants to join (any wording: "main dealer hoon", "mujhe bhi
// listing daalni hai", "kaise judein?"), and keeps talking to them while
// they join. This service owns the part that must be exact: the
// pending_agent_signups row (same table the admin "Agent Signups" tab
// approves), which details are still missing, and the line telling them
// what to send next. Name/area come from the assistant's reading of the
// conversation, cross-checked by the existing signup extractor, so a joiner
// is never asked twice for something they already said.

const { normalizePhone } = require('../utils/phone');

const extractAgentSignupFields = (...a) => require('./agentSignupExtractionService').extractAgentSignupFields(...a);

/**
 * Which tenant a self-registered agent is filed under. Same resolution as
 * before (receiving number's tenant, else the oldest active tenant); the
 * super-admin reviews every request in Admin -> Agent Signups either way.
 */
async function resolveTenantForSignup(knex, { receivingPhoneNumberId, receivingNumber } = {}) {
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

async function findPendingSignup(knex, phone) {
  return knex('pending_agent_signups')
    .where({ phone: normalizePhone(phone) || phone, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first();
}

async function findLastRejectedSignup(knex, phone) {
  return knex('pending_agent_signups')
    .where({ phone: normalizePhone(phone) || phone, status: 'rejected' })
    .orderBy('updated_at', 'desc')
    .first('updated_at');
}

/**
 * Someone who was joining as a dealer then says they want to SELL their own
 * property is an owner, not a dealer applicant: close the open request so the
 * team doesn't review it and the assistant stops asking for name/area.
 * Returns the number of requests cancelled.
 */
async function cancelPendingSignup(knex, phone) {
  return knex('pending_agent_signups')
    .where({ phone: normalizePhone(phone) || phone, status: 'pending' })
    .update({ status: 'cancelled', updated_at: knex.fn.now() });
}

function isComplete(signup) {
  return Boolean(signup && signup.name && signup.address);
}

/** Pure (unit-tested): the line appended to the assistant's reply. */
function signupFollowUp({ name, address, justCompleted, lang }) {
  if (justCompleted) {
    return lang === 'en'
      ? `✅ Done! Your request to join (Name: *${name}*, Area: *${address}*) has gone to the Plotraa team for approval. You'll get a message on this number once it's approved; then pick a plan and send your first property.`
      : `✅ Ho gaya! Aapka join request (Naam: *${name}*, Area: *${address}*) Plotraa team ko approval ke liye bhej diya hai. Approve hote hi isi number pe message aayega, phir plan chunke apni pehli property bhej sakte ho.`;
  }
  const need = [];
  if (!name) need.push(lang === 'en' ? 'your *full name*' : 'aapka *poora naam*');
  if (!address) need.push(lang === 'en' ? 'the *area/city you work in*' : 'aap *kis area/city mein kaam karte ho*');
  if (!need.length) return null;
  return lang === 'en'
    ? `📝 To join, just send ${need.join(' and ')}.`
    : `📝 Join karne ke liye bas ${need.join(' aur ')} bata dijiye.`;
}

function clean(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Starts or continues a signup from the assistant. `fields` is what the
 * assistant read from the conversation ({ name, area }). Returns
 * { signup, followUp, justCompleted } or null when there's nothing to do.
 */
async function advanceSignupFromAssistant(knex, { phone, text, fields = {}, lang, receiving = {}, start = false }) {
  const normalizedPhone = normalizePhone(phone) || phone;
  let signup = await findPendingSignup(knex, normalizedPhone);
  if (!signup && !start) return null;
  const wasComplete = isComplete(signup);

  if (!signup) {
    const tenant = await resolveTenantForSignup(knex, receiving);
    if (!tenant) return null;
    [signup] = await knex('pending_agent_signups').insert({
      tenant_id: tenant.id,
      phone: normalizedPhone,
      accumulated_text: String(text || '').slice(0, 4000),
    }).returning('*');
  } else if (!wasComplete) {
    [signup] = await knex('pending_agent_signups').where({ id: signup.id }).update({
      accumulated_text: knex.raw(`TRIM(COALESCE(accumulated_text, '') || ' ' || ?)`, [String(text || '').slice(0, 4000)]),
      updated_at: knex.fn.now(),
    }).returning('*');
  }

  if (wasComplete) {
    // Already with the team. Nothing to collect; the assistant's own reply
    // (which knows the request is pending) is the whole answer.
    return { signup, followUp: null, justCompleted: false };
  }

  // The assistant's reading first; the dedicated extractor as a cross-check
  // over everything they've said while joining.
  let name = clean(fields.name, 255);
  let address = clean(fields.area, 1000);
  if (!name || !address) {
    try {
      const extracted = await extractAgentSignupFields(signup.accumulated_text || text);
      name = name || clean(extracted?.name, 255);
      address = address || clean(extracted?.address, 1000);
    } catch (err) {
      console.error('[signup] extractor failed (continuing with assistant fields):', err.message);
    }
  }

  const patch = {};
  if (name && !signup.name) patch.name = name;
  if (address && !signup.address) patch.address = address;
  if (Object.keys(patch).length) {
    [signup] = await knex('pending_agent_signups').where({ id: signup.id }).update({ ...patch, updated_at: knex.fn.now() }).returning('*');
  }

  const justCompleted = isComplete(signup);
  if (justCompleted) console.log('[signup] request complete for %s (%s, %s)', normalizedPhone, signup.name, signup.address);
  return {
    signup,
    justCompleted,
    followUp: signupFollowUp({ name: signup.name, address: signup.address, justCompleted, lang }),
  };
}

/** Plain-text description of where this person is in joining, for the assistant. */
async function describeSignupState(knex, phone) {
  const pending = await findPendingSignup(knex, phone);
  if (pending) {
    return isComplete(pending)
      ? `- They have ALREADY applied to join as an agent (name: ${pending.name}, area: ${pending.address}); the request is waiting for Plotraa team approval. They can't list properties until approved. Answer their questions; don't restart joining.`
      : `- They are in the middle of JOINING as an agent. Still needed: ${[!pending.name && 'full name', !pending.address && 'area/city they work in'].filter(Boolean).join(' and ')}. If this message gives either, use action "start_signup" and fill "signup". If they ask something, answer it (the system adds the reminder of what's still needed).`;
  }
  const rejected = await findLastRejectedSignup(knex, phone);
  if (rejected) {
    return '- An earlier request from this number to join as an agent was NOT approved. If they ask about it or want to join again, be kind, don\'t start a new signup, and use action "support" so the team can talk to them.';
  }
  return null;
}

module.exports = {
  resolveTenantForSignup,
  findPendingSignup,
  cancelPendingSignup,
  advanceSignupFromAssistant,
  describeSignupState,
  signupFollowUp,
  isComplete,
};
