// src/services/assistantService.js
//
// Plotraa Assistant: a conversational guide on WhatsApp for three audiences.
//
//   agent   - a registered dealer/agent. Answers "how does this work",
//             explains what went wrong ("preview kyun nahi aaya?"), guides
//             through the listing steps, and raises a support request when
//             they have a problem it can't solve.
//   visitor - an unknown number on the Plotraa platform number: a dealer
//             thinking of joining, a buyer, or an owner who wants to sell.
//             Answers questions honestly with the real plans, no hard selling.
//   buyer   - an unknown number on a DEALER's own number: that dealer's
//             customer. Helps them search and connect with the dealer.
//
// It only ever TALKS. Everything that changes data (listing, approving,
// marking sold, payments) stays with the existing handlers; the assistant
// tells people what to send. The only things it creates are a support
// request (team alert), a dealer lead (buyer wants to be contacted) and a
// seller lead (owner wants to sell).
//
// Fails open: on any error it returns { handled: false } and the caller uses
// its previous reply (help menu / greeting), except that a message that
// clearly asks for help still raises a support request.

const axios = require('axios');
const { PRODUCT, RULES, offersText } = require('../assistant/plotraaKnowledge');
const { detectReplyLanguage } = require('../utils/replyLanguage');
const { normalizePhone } = require('../utils/phone');
const { looksLikeSellerIntent, extractSellerHints } = require('../utils/sellerIntent');
const { raiseSupportRequest } = require('./supportRequestService');
const { advanceSignupFromAssistant, describeSignupState, findPendingSignup, isComplete } = require('./agentSignupService');

const enqueueWhatsapp = (...a) => require('./agentMessagingService').enqueueAgentWhatsappSend(...a);

const AUDIENCES = ['agent', 'visitor', 'buyer'];
const ACTIONS = ['none', 'support', 'callback', 'seller_lead', 'start_signup'];
const HISTORY_TURNS = 10;
const HISTORY_WINDOW_HOURS = 48;
const MAX_REPLY_CHARS = 1200;
const LIVE_DRAFT_STATUSES = ['collecting', 'extracting', 'creating', 'enriching', 'awaiting_approval'];

// Plain-language reason a listing in this status is not live, handed to the
// model so it explains the real cause instead of guessing (it used to blame
// the location pin, which never blocks publishing).
const LISTING_STATUS_MEANING = {
  awaiting_approval: 'the preview was sent; the listing goes live as soon as the dealer replies "haan" / "yes". The location pin is NOT the reason.',
  pending_geo_review: 'the Plotraa team is checking the location and will notify the dealer once approved (sending the exact location pin also resolves it).',
  pending: 'the listing is still being prepared; the next message from the bot says what is needed.',
  unconfirmed: 'the dealer has not confirmed the listing yet.',
  active: 'the listing is already live.',
};

function isAssistantEnabled() {
  return String(process.env.PLOTRAA_ASSISTANT || 'on').toLowerCase() !== 'off';
}

// Used only when the model is unavailable: a message that obviously asks
// for a person/help still reaches the team instead of getting lost.
const SUPPORT_PATTERNS = [
  /\b(call|phone)\s*(me|kar|karo|kariye|karna)\b/i, /\bcall\s*back\b/i, /\bbaat\s*kar(ni|na|wao|o)?\b/i,
  /\b(problem|issue|complaint|shikayat|dikkat|pareshani|galti)\b/i, /\b(not|nahi|nhi)\s*(working|chal|ho\s*raha|aa\s*raha)\b/i,
  /\b(help|madad|sahayata)\b/i, /\b(team|support|customer\s*care)\b/i, /\brefund\b/i,
];
function looksLikeSupportRequest(text) {
  return SUPPORT_PATTERNS.some((re) => re.test(String(text || '')));
}

// ------------------------------------------------------------------ context

function formatInr(n) {
  return `₹${Number(n).toLocaleString('en-IN')}`;
}

function parseFeatures(features) {
  if (!features) return [];
  if (Array.isArray(features)) return features;
  try { const f = JSON.parse(features); return Array.isArray(f) ? f : []; } catch { return []; }
}

/** Pure (unit-tested): the plan list exactly as the website shows it. */
function formatPlansForPrompt(plans) {
  if (!plans.length) return 'PLANS\n- Plan details are not available right now; say the team will share them.';
  const lines = plans.map((p) => {
    const price = `${formatInr(p.price_inr)}/month${p.discount_percent ? ` (${p.discount_percent}% off)` : ''}`;
    const features = parseFeatures(p.features).join('; ');
    return `- ${p.label}: ${price}${features ? `. Includes: ${features}` : ''}`;
  });
  return `PLANS (same for everyone, prices include GST)\n${lines.join('\n')}`;
}

async function loadPlans(knex) {
  return knex('plans').where({ is_active: true }).orderBy('sort_order', 'asc')
    .select('label', 'price_inr', 'discount_percent', 'features');
}

async function loadAgentContext(knex, agentUser) {
  const [tenant, pkg, counts, draft, pendingReceipt] = await Promise.all([
    knex('tenants').where({ id: agentUser.tenant_id }).first('business_name', 'agent_rating', 'agent_experience_years', 'rera_certified'),
    agentUser.package_id ? knex('packages').where({ id: agentUser.package_id }).first('name', 'amount_inr') : null,
    knex('listings').where({ tenant_id: agentUser.tenant_id }).whereNull('deleted_at')
      .andWhere((b) => b.where('created_by', agentUser.id).orWhere('assigned_agent_id', agentUser.id))
      .groupBy('status').select('status').count('id as n'),
    knex('agent_listing_drafts').where({ user_id: agentUser.id, tenant_id: agentUser.tenant_id })
      .whereIn('status', LIVE_DRAFT_STATUSES).orderBy('updated_at', 'desc').first(),
    knex('payment_submissions').where({ agent_id: agentUser.id, status: 'pending' }).first('submitted_at'),
  ]);

  let draftLines = 'No listing in progress.';
  if (draft) {
    const recent = await knex('agent_draft_messages').where({ draft_id: draft.id })
      .orderBy('created_at', 'desc').limit(6).select('direction', 'body');
    const listing = draft.listing_id ? await knex('listings').where({ id: draft.listing_id }).first('status', 'title', 'public_slug') : null;
    draftLines = [
      `Listing in progress: draft status "${draft.status}"${listing ? `, listing "${listing.title}" status "${listing.status}"` : ', listing not created yet'}.`,
      listing && LISTING_STATUS_MEANING[listing.status] ? `Meaning: ${LISTING_STATUS_MEANING[listing.status]}` : null,
      draft.missing_fields ? `Bot is waiting for: ${JSON.stringify(draft.missing_fields)}.` : null,
      draft.location_pin_requested_at && !draft.listing_id ? 'Bot asked for the exact location pin (they can reply "pin nahi" to skip).' : null,
      'Recent listing conversation (newest last):',
      ...recent.reverse().map((m) => `  ${m.direction === 'inbound' ? 'Agent' : 'Bot'}: ${String(m.body || '').slice(0, 300)}`),
    ].filter(Boolean).join('\n');
  }

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
  return [
    'CONTEXT (this person is a registered agent)',
    `- Name: ${agentUser.name || '-'}; business: ${tenant?.business_name || '-'}`,
    `- Plan: ${pkg ? `${pkg.name} (${formatInr(pkg.amount_inr)}/month)` : 'no plan chosen yet'}; payment status: ${agentUser.payment_status || '-'}${pendingReceipt ? ' (a receipt is waiting for team review)' : ''}`,
    `- Can add new listings: ${agentUser.can_add_listing ? 'yes' : 'NO (payment pending; existing listings stay live)'}`,
    `- Their listings by status: ${Object.keys(byStatus).length ? JSON.stringify(byStatus) : 'none yet'}`,
    `- Public profile: rating ${tenant?.agent_rating ?? 'not set'}, experience ${tenant?.agent_experience_years ?? 'not set'} years, RERA ${tenant?.rera_certified ? 'yes' : 'no'}`,
    draftLines,
  ].join('\n');
}

async function loadBuyerContext(knex, tenantId, { isFirstMessage } = {}) {
  const [tenant, listingCount, areas] = await Promise.all([
    knex('tenants').where({ id: tenantId }).first('business_name', 'agent_rating', 'agent_experience_years', 'rera_certified'),
    knex('listings').where({ tenant_id: tenantId, status: 'active' }).whereNull('deleted_at').count('id as n').first(),
    knex('listings').where({ tenant_id: tenantId, status: 'active' }).whereNull('deleted_at').whereNotNull('general_area')
      .groupBy('general_area').select('general_area').count('id as n').orderBy('n', 'desc').limit(8),
  ]);
  return [
    'CONTEXT (this person messaged a DEALER\'s own WhatsApp number; they are most likely that dealer\'s customer)',
    `- Dealer: ${tenant?.business_name || '-'}; rating ${tenant?.agent_rating ?? 'not set'}, experience ${tenant?.agent_experience_years ?? 'not set'} years, RERA ${tenant?.rera_certified ? 'yes' : 'no'}`,
    `- Dealer has ${Number(listingCount?.n || 0)} live listings${areas.length ? `, mostly in: ${areas.map((a) => a.general_area).join(', ')}` : ''}.`,
    isFirstMessage ? '- This is their FIRST message: greet them on behalf of the dealer and ask what they are looking for (type, area, budget), or if they want to sell.' : null,
    '- Help them describe what they want (type, area, budget, size) so matching listings can be sent, or take a call-back request for this dealer. Do not pitch Plotraa plans to them.',
  ].filter(Boolean).join('\n');
}

async function loadVisitorContext(knex, { phone, name, isFirstMessage }) {
  const signupState = await describeSignupState(knex, phone);
  return [
    'CONTEXT (unknown number on the Plotraa platform WhatsApp)',
    isFirstMessage ? '- This is their FIRST message to Plotraa.' : null,
    name ? `- Their WhatsApp profile name is "${name}" (may be a nickname; don't assume it's their full name).` : null,
    signupState || '- Could be a dealer/agent curious about Plotraa or wanting to join, a buyer looking for property, or an owner wanting to sell. Work out which from what they say; ask one short question if unclear.',
    '- Dealers: explain honestly how it works and the plans if asked, and help them join (action "start_signup"). Buyers: ask what they need (type, area, budget). Owners: take property type, area/city and expected price.',
  ].filter(Boolean).join('\n');
}

async function loadHistory(knex, phone, audience) {
  const rows = await knex('assistant_messages')
    .where({ phone, audience })
    .where('created_at', '>=', knex.raw(`NOW() - INTERVAL '${HISTORY_WINDOW_HOURS} hours'`))
    .orderBy('created_at', 'desc').limit(HISTORY_TURNS).select('direction', 'body');
  return rows.reverse().map((r) => ({ role: r.direction === 'inbound' ? 'user' : 'assistant', content: String(r.body).slice(0, 1200) }));
}

// ------------------------------------------------------------------ model

function buildSystemPrompt({ audience, contextText, plansText, langHint = null }) {
  const audienceNote = {
    agent: 'You are talking to a registered Plotraa agent. Be their friendly, patient assistant and guide.',
    visitor: 'You are talking to someone new on the Plotraa WhatsApp number.',
    buyer: 'You are answering on behalf of a dealer, to that dealer\'s customer. Be helpful and neutral; never sell Plotraa plans here.',
  }[audience];

  return `${audienceNote}

${RULES}

${PRODUCT}

${plansText}

${offersText()}

${contextText}
${langHint === 'hi' ? '\nLANGUAGE: the person writes Hindi/Hinglish/Punjabi. Reply in Hinglish (Roman script) or in the script they used, NOT in English.' : langHint === 'en' ? '\nLANGUAGE: the person writes English. Reply in English.' : ''}

Return ONLY JSON:
{"reply": "the WhatsApp message to send",
 "reply_language": "en" if they write plain English, otherwise "hi" (Hindi, Punjabi, Hinglish or any mix),
 "action": one of ${JSON.stringify(ACTIONS)},
 "support_kind": "problem" or "complaint" (only when action is "support"),
 "summary": "one line for the Plotraa team describing what this person needs" (required unless action is "none"),
 "seller": {"property_type": string|null, "city": string|null, "locality": string|null, "expected_price": string|null, "size_text": string|null} (only for "seller_lead"),
 "signup": {"name": string|null, "area": string|null} (only for "start_signup"; only what they actually said)}`;
}

/** Pure (unit-tested): validates the model output. Returns null if unusable. */
function parseAssistantOutput(raw) {
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) return null;
  const action = ACTIONS.includes(parsed.action) ? parsed.action : 'none';
  const reply = parsed.reply.trim().slice(0, MAX_REPLY_CHARS);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const seller = parsed.seller && typeof parsed.seller === 'object'
    ? {
        property_type: str(parsed.seller.property_type), city: str(parsed.seller.city), locality: str(parsed.seller.locality),
        expected_price: str(parsed.seller.expected_price), size_text: str(parsed.seller.size_text),
      }
    : null;
  const signup = parsed.signup && typeof parsed.signup === 'object'
    ? { name: str(parsed.signup.name), area: str(parsed.signup.area) }
    : null;
  return {
    reply,
    action,
    supportKind: parsed.support_kind === 'complaint' ? 'complaint' : 'problem',
    summary: str(parsed.summary),
    replyLanguage: parsed.reply_language === 'en' || parsed.reply_language === 'hi' ? parsed.reply_language : null,
    seller,
    signup,
  };
}

async function callModel(messages) {
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: process.env.PLOTRAA_ASSISTANT_MODEL || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 700,
    messages,
  }, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    timeout: Number(process.env.PLOTRAA_ASSISTANT_TIMEOUT_MS || 15000),
  });
  return response.data.choices[0].message.content;
}

// ------------------------------------------------------------------ actions

async function createDealerLead(knex, { tenantId, phone, name, source }) {
  const existing = await knex('leads').where({ tenant_id: tenantId, phone }).first('id');
  if (existing) return existing.id;
  const [lead] = await knex('leads').insert({ tenant_id: tenantId, name: name || null, phone, source, status: 'new' }).returning(['id']);
  return lead.id;
}

async function createSellerLead(knex, { phone, name, seller, summary }) {
  const dup = await knex('seller_leads').where({ phone, status: 'new' })
    .where('created_at', '>=', knex.raw("NOW() - INTERVAL '1 day'")).first('id');
  if (dup) return dup.id;
  const [row] = await knex('seller_leads').insert({
    name: name || 'WhatsApp contact',
    phone,
    property_type: seller?.property_type?.slice(0, 50) || null,
    city: seller?.city?.slice(0, 100) || null,
    locality: seller?.locality?.slice(0, 255) || null,
    expected_price: seller?.expected_price?.slice(0, 100) || null,
    size_text: seller?.size_text?.slice(0, 100) || null,
    description: summary ? `Via WhatsApp assistant: ${summary}`.slice(0, 2000) : 'Via WhatsApp assistant',
    source: 'whatsapp',
  }).returning(['id']);
  return row.id;
}

async function performAction(knex, out, { audience, phone, name, text, agentUser, tenantId }) {
  const base = { phone, name: name || agentUser?.name, audience, summary: out.summary, lastMessage: text, tenantId: agentUser?.tenant_id || tenantId || null, userId: agentUser?.id || null };
  switch (out.action) {
    case 'support':
      await raiseSupportRequest(knex, { ...base, kind: out.supportKind });
      return 'support';
    case 'callback':
      if (audience === 'buyer' && tenantId) {
        await createDealerLead(knex, { tenantId, phone, name, source: 'whatsapp_assistant' });
        return 'dealer_lead';
      }
      await raiseSupportRequest(knex, { ...base, kind: 'callback' });
      return 'support';
    case 'seller_lead':
      if (audience === 'buyer' && tenantId) {
        // An owner on a dealer's own number is that dealer's client.
        await createDealerLead(knex, { tenantId, phone, name, source: 'whatsapp_seller' });
        return 'dealer_lead';
      }
      await createSellerLead(knex, { phone, name, seller: out.seller, summary: out.summary });
      return 'seller_lead';
    default:
      return 'none';
  }
}

function fallbackSupportReply(lang) {
  return lang === 'en'
    ? "🙏 Got it. I've told the Plotraa team, someone will contact you on this number shortly."
    : '🙏 Samajh gaya. Plotraa team ko bata diya hai, koi jaldi isi number pe aapse sampark karega.';
}

// ------------------------------------------------------------------ entry

/**
 * Answers one message. Never throws.
 *
 *   audience  'agent' | 'visitor' | 'buyer'
 *   agentUser users row (audience 'agent')
 *   tenantId  the dealer whose number was messaged (audience 'buyer')
 *   name      WhatsApp profile name, when known
 *   receiving { receivingPhoneNumberId, receivingNumber } of the inbound
 *             message (audience 'visitor'), used to file a new joiner
 *   startSignup  true when they used an explicit join phrase ("join as agent")
 *
 * Returns { handled: true, action } once a reply is queued, or
 * { handled: false } so the caller can use its old reply.
 */
async function handleWithAssistant(knex, { audience, phone, text, name = null, agentUser = null, tenantId = null, receiving = {}, startSignup = false }) {
  if (!AUDIENCES.includes(audience) || !text || !text.trim()) return { handled: false };
  const normalizedPhone = normalizePhone(agentUser?.phone || phone) || phone;
  const sendTenantId = agentUser?.tenant_id || tenantId || null;
  const lang = detectReplyLanguage(text);

  if (!isAssistantEnabled() || !process.env.OPENAI_API_KEY) {
    if (audience === 'agent' && looksLikeSupportRequest(text)) {
      await raiseSupportRequest(knex, { phone: normalizedPhone, name: name || agentUser?.name, audience, kind: 'problem', lastMessage: text, tenantId: sendTenantId, userId: agentUser?.id || null });
      await enqueueWhatsapp({ tenantId: sendTenantId, phone: normalizedPhone, messageBody: fallbackSupportReply(lang) }).catch(() => {});
      return { handled: true, action: 'support' };
    }
    return { handled: false };
  }

  try {
    // First contact ever with this number (no assistant chat in any role):
    // the assistant opens with a short welcome and the three paths.
    const isFirstMessage = audience !== 'agent'
      && !(await knex('assistant_messages').where({ phone: normalizedPhone }).first('id'));

    const [plans, contextText, history] = await Promise.all([
      loadPlans(knex),
      audience === 'agent' ? loadAgentContext(knex, agentUser)
        : audience === 'buyer' ? loadBuyerContext(knex, tenantId, { isFirstMessage })
          : loadVisitorContext(knex, { phone: normalizedPhone, name, isFirstMessage }),
      loadHistory(knex, normalizedPhone, audience),
    ]);

    const messages = [
      { role: 'system', content: buildSystemPrompt({ audience, contextText, plansText: formatPlansForPrompt(plans), langHint: detectReplyLanguage([...history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content), text].join(' ')) }) },
      ...history,
      { role: 'user', content: String(text).slice(0, 2000) },
    ];

    const out = parseAssistantOutput(await callModel(messages));
    if (!out) throw new Error('unusable model output');

    // Deterministic safety net: an owner saying they want to sell must become
    // a seller lead even when the model picked another action (it used to
    // answer "bechni hai" with a buyer reply, or treat it as dealer joining).
    const isSellerMessage = audience !== 'agent' && !startSignup && looksLikeSellerIntent(text);
    if (isSellerMessage && out.action !== 'seller_lead') {
      const hints = extractSellerHints(text);
      out.action = 'seller_lead';
      out.seller = {
        property_type: out.seller?.property_type || hints.property_type,
        city: out.seller?.city || null,
        locality: out.seller?.locality || null,
        expected_price: out.seller?.expected_price || hints.expected_price,
        size_text: out.seller?.size_text || hints.size_text,
      };
      out.summary = out.summary || `Owner wants to sell: ${String(text).slice(0, 200)}`;
    }

    let action = await performAction(knex, out, { audience, phone: normalizedPhone, name, text, agentUser, tenantId });
    let reply = out.reply;

    // Joining as an agent (platform number only). Starts on "start_signup";
    // once a signup is open, every message goes through here so a name or
    // area mentioned in passing is never lost. The system, not the model,
    // adds the "still need X" / "request submitted" line.
    // A selling message is never a joining message, so no "still need your
    // name/area" line is appended to a seller's reply.
    if (audience === 'visitor' && !isSellerMessage) {
      const convoLang = out.replyLanguage
        || detectReplyLanguage([...history.filter((m) => m.role === 'user').map((m) => m.content), text].join(' '));
      const signupStep = await advanceSignupFromAssistant(knex, {
        phone: normalizedPhone,
        text,
        fields: out.signup || {},
        lang: convoLang,
        receiving,
        start: out.action === 'start_signup' || startSignup,
      });
      if (signupStep) {
        if (signupStep.followUp) reply = `${reply}\n\n${signupStep.followUp}`;
        if (signupStep.justCompleted || out.action === 'start_signup' || startSignup || signupStep.followUp) {
          action = signupStep.justCompleted ? 'signup_submitted' : 'signup';
        }
      }
    }

    await knex('assistant_messages').insert([
      { phone: normalizedPhone, audience, tenant_id: sendTenantId, user_id: agentUser?.id || null, direction: 'inbound', body: String(text).slice(0, 4000) },
      { phone: normalizedPhone, audience, tenant_id: sendTenantId, user_id: agentUser?.id || null, direction: 'outbound', body: reply, action },
    ]);

    await enqueueWhatsapp({ tenantId: sendTenantId, phone: normalizedPhone, messageBody: reply });
    console.log('[Assistant] %s %s action=%s', audience, normalizedPhone, action);
    return { handled: true, action };
  } catch (err) {
    console.error('[Assistant] failed, caller falls back:', err.message);
    if (audience === 'agent' && looksLikeSupportRequest(text)) {
      await raiseSupportRequest(knex, { phone: normalizedPhone, name: name || agentUser?.name, audience, kind: 'problem', lastMessage: text, tenantId: sendTenantId, userId: agentUser?.id || null });
      await enqueueWhatsapp({ tenantId: sendTenantId, phone: normalizedPhone, messageBody: fallbackSupportReply(lang) }).catch(() => {});
      return { handled: true, action: 'support' };
    }
    return { handled: false };
  }
}

module.exports = {
  handleWithAssistant,
  parseAssistantOutput,
  formatPlansForPrompt,
  looksLikeSupportRequest,
  buildSystemPrompt,
  LISTING_STATUS_MEANING,
};
