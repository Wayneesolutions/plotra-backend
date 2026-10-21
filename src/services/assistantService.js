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
const { PRODUCT, RULES, offersText, PUBLIC_SITE } = require('../assistant/plotraaKnowledge');
const { detectReplyLanguage, detectMessageLanguage, detectScript } = require('../utils/replyLanguage');
const { normalizePhone } = require('../utils/phone');
const { looksLikeSellerIntent, extractSellerHints } = require('../utils/sellerIntent');
const { raiseSupportRequest } = require('./supportRequestService');
const { advanceSignupFromAssistant, cancelPendingSignup, describeSignupState } = require('./agentSignupService');
const { looksLikeKnownQuestion } = require('../utils/agentQuickIntent');

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
// STRONG patterns are a request or a problem on their own; WEAK ones ("help",
// "support", "team") also appear in plain questions ("support number?"), so
// they only count when the message is not a question.
const STRONG_SUPPORT_PATTERNS = [
  /\b(call|phone)\s*(me|kar|karo|kariye|karna)\b/i, /\bcall\s*back\b/i, /\bbaat\s*kar(ni|na|wao|o)?\b/i,
  /\b(problem|issue|complaint|shikayat|dikkat|pareshani|galti)\b/i, /\b(not|nahi|nhi)\s*(working|chal|ho\s*raha|aa\s*raha)\b/i,
  /\brefund\b/i,
];
const WEAK_SUPPORT_PATTERNS = [/\b(help|madad|sahayata)\b/i, /\b(team|support|customer\s*care)\b/i];
const QUESTION_SHAPE = /\?|\b(?:kya|kaise|kitna|kitne|kab|kahan|number|no)\b/i;

function looksLikeSupportRequest(text) {
  const t = String(text || '');
  if (STRONG_SUPPORT_PATTERNS.some((re) => re.test(t))) return true;
  if (looksLikeKnownQuestion(t) || QUESTION_SHAPE.test(t)) return false;
  return WEAK_SUPPORT_PATTERNS.some((re) => re.test(t));
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

function buildSystemPrompt({ audience, contextText, plansText, langHint = null, script = null }) {
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
${langHint === 'hi'
    ? (script === 'gurmukhi' ? '\nLANGUAGE: the person writes Punjabi in Gurmukhi. Reply in simple, natural everyday Punjabi in Gurmukhi, NOT in English.'
      : script === 'devanagari' ? '\nLANGUAGE: the person writes Hindi in Devanagari. Reply in Hindi in Devanagari, NOT in English.'
        : '\nLANGUAGE: the person writes Hinglish in Roman script. Reply in Roman-script Hinglish only: no Gurmukhi, no Devanagari, not English.')
    : langHint === 'en' ? '\nLANGUAGE: the person writes English. Reply in English only.' : ''}

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
  const fields = {
    property_type: seller?.property_type?.slice(0, 50) || null,
    city: seller?.city?.slice(0, 100) || null,
    locality: seller?.locality?.slice(0, 255) || null,
    expected_price: seller?.expected_price?.slice(0, 100) || null,
    size_text: seller?.size_text?.slice(0, 100) || null,
  };
  const dup = await knex('seller_leads').where({ phone, status: 'new' })
    .where('created_at', '>=', knex.raw("NOW() - INTERVAL '1 day'")).first('*');
  if (dup) {
    // The same owner adding details ("Dugri mein hai", then "1.5 crore") updates
    // the open lead instead of being ignored: only blanks are filled in.
    const patch = {};
    for (const [k, v] of Object.entries(fields)) if (v && !dup[k]) patch[k] = v;
    if (Object.keys(patch).length) await knex('seller_leads').where({ id: dup.id }).update({ ...patch, updated_at: knex.fn.now() });
    return dup.id;
  }
  const [row] = await knex('seller_leads').insert({
    name: name || 'WhatsApp contact',
    phone,
    ...fields,
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

function fallbackSellerReply(lang) {
  return lang === 'en'
    ? '🙏 Thank you. A verified local dealer will contact you on this number about selling your property. Please also tell us the property type, area and expected price if you have not already.'
    : '🙏 Dhanyavaad. Ek verified local dealer aapse isi number pe property bechne ke liye sampark karega. Property ka type, area aur expected price bhi bata dijiye agar abhi tak nahi bataya.';
}

/**
 * Seller message handled WITHOUT the model (assistant off, or it failed): the
 * lead is still saved and any open dealer signup closed, so an owner is never
 * lost because of an outage. Returns true when handled.
 */
async function handleSellerWithoutModel(knex, { audience, phone, name, text, tenantId, lang }) {
  if (audience === 'agent' || !looksLikeSellerIntent(text)) return false;
  try {
    if (audience === 'buyer' && tenantId) {
      await createDealerLead(knex, { tenantId, phone, name, source: 'whatsapp_seller' });
    } else {
      await cancelPendingSignup(knex, phone);
      await createSellerLead(knex, { phone, name, seller: extractSellerHints(text), summary: `Owner wants to sell: ${String(text).slice(0, 200)}` });
    }
    await enqueueWhatsapp({ tenantId: tenantId || null, phone, messageBody: fallbackSellerReply(lang) });
    return true;
  } catch (err) {
    console.error('[Assistant] seller fallback failed:', err.message);
    return false;
  }
}

/** Pure (unit-tested): an informational question with no problem or call request in it. */
function isPlainQuestion(text) {
  const t = String(text || '');
  if (STRONG_SUPPORT_PATTERNS.some((re) => re.test(t))) return false;
  return looksLikeKnownQuestion(t) || (/\?/.test(t) && !looksLikeSellerIntent(t));
}

// A discount question is answered in a line or two; models pad it with the
// plan list. Trims at a sentence/line end so it never stops mid-word.
const DISCOUNT_QUESTION = /(?:discount|offer|coupon|trial|chhoot|chhut|sasta|ਡਿਸਕਾਊਂਟ|ਡਿਸਕਾਉਂਟ|ਛੋਟ|ਆਫਰ|ਆਫ਼ਰ|डिस्काउंट|छूट|ऑफर)/i;
const SHORT_REPLY_CHARS = 280;
function capShortReply(reply, text) {
  if (!DISCOUNT_QUESTION.test(String(text || '')) || reply.length <= SHORT_REPLY_CHARS) return reply;
  const head = reply.slice(0, SHORT_REPLY_CHARS);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '), head.lastIndexOf('। '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return (cut > 80 ? head.slice(0, cut + 1) : head.replace(/\s+\S*$/, '…')).trim();
}

/** Website form offered next to the WhatsApp path, by who the visitor turned out to be. */
function visitorFormLine({ action, lang }) {
  if (action === 'start_signup') return lang === 'en' ? `🌐 Prefer a form? Apply at ${PUBLIC_SITE}/request-access` : `🌐 Form pasand hai? Yahan apply karein: ${PUBLIC_SITE}/request-access`;
  if (action === 'seller_lead') return lang === 'en' ? `🌐 You can also list your property at ${PUBLIC_SITE}/sell-property` : `🌐 Aap yahan bhi apni property daal sakte hain: ${PUBLIC_SITE}/sell-property`;
  return null;
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
    if (await handleSellerWithoutModel(knex, { audience, phone: normalizedPhone, name, text, tenantId, lang })) {
      return { handled: true, action: 'seller_lead' };
    }
    return { handled: false };
  }

  let supportRaised = false;
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

    // The language of THIS message decides the reply; earlier turns only break
    // a tie when the message is too short to tell ("ok", "Dugri").
    const msgLang = detectMessageLanguage(text);
    const messages = [
      { role: 'system', content: buildSystemPrompt({ audience, contextText, plansText: formatPlansForPrompt(plans), script: detectScript(text), langHint: msgLang || detectReplyLanguage([...history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content), text].join(' ')) }) },
      ...history,
      { role: 'user', content: String(text).slice(0, 2000) },
    ];

    const out = parseAssistantOutput(await callModel(messages));
    if (!out) throw new Error('unusable model output');

    // A plain question ("support number?", "upgrade kaise karu?") is answered,
    // never ticketed, even when the model picked "support" for it. A real
    // problem or call request in the same text keeps the ticket.
    if ((out.action === 'support' || out.action === 'callback') && isPlainQuestion(text)) {
      console.log('[Assistant] %s %s plain question, not raising %s', audience, normalizedPhone, out.action);
      out.action = 'none';
    }

    // Deterministic safety net: an owner saying they want to sell must become
    // a seller lead even when the model picked another action (it used to
    // answer "bechni hai" with a buyer reply, or treat it as dealer joining).
    const isSellerMessage = audience !== 'agent' && !startSignup
      && (looksLikeSellerIntent(text) || out.action === 'seller_lead');
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
    supportRaised = action === 'support';
    let reply = capShortReply(out.reply, text);

    // An owner selling their own property is not a dealer applicant: close
    // any open join request (it used to stay open and swallow the seller).
    if (isSellerMessage && audience === 'visitor') {
      const cancelled = await cancelPendingSignup(knex, normalizedPhone);
      if (cancelled) console.log('[Assistant] cancelled %d open signup(s) for seller %s', cancelled, normalizedPhone);
    }

    // Joining as an agent (platform number only). Starts on "start_signup";
    // once a signup is open, every message goes through here so a name or
    // area mentioned in passing is never lost. The system, not the model,
    // adds the "still need X" / "request submitted" line.
    // A selling message is never a joining message, so no "still need your
    // name/area" line is appended to a seller's reply.
    if (audience === 'visitor' && !isSellerMessage) {
      const convoLang = msgLang
        || out.replyLanguage
        || detectReplyLanguage([...history.filter((m) => m.role === 'user').map((m) => m.content), text].join(' '));
      // A first message that is only a name and a working area (often Gurmukhi)
      // is a dealer joining even if the model left the action at "none".
      const gaveNameAndArea = Boolean(out.signup?.name && out.signup?.area) && out.action === 'none';
      if (gaveNameAndArea) out.action = 'start_signup';
      const signupStep = await advanceSignupFromAssistant(knex, {
        phone: normalizedPhone,
        text,
        fields: out.signup || {},
        lang: convoLang,
        script: detectScript(text),
        receiving,
        start: out.action === 'start_signup' || startSignup,
      });
      if (signupStep) {
        if (signupStep.followUp) reply = `${reply}\n\n${signupStep.followUp}`;
        if (signupStep.justCompleted || out.action === 'start_signup' || startSignup || signupStep.followUp) {
          action = signupStep.justCompleted ? 'signup_submitted' : 'signup';
        }
      }
      // Dealers also get the web form, once, when they start joining.
      if (signupStep && !signupStep.justCompleted && (out.action === 'start_signup' || startSignup) && !history.some((m) => m.role === 'assistant' && m.content.includes('/request-access'))) {
        const line = visitorFormLine({ action: 'start_signup', lang: convoLang });
        if (line) reply = `${reply}\n\n${line}`;
      }
    }
    if (audience === 'visitor' && isSellerMessage && !history.some((m) => m.role === 'assistant' && m.content.includes('/sell-property'))) {
      const line = visitorFormLine({ action: 'seller_lead', lang: msgLang || out.replyLanguage || lang });
      if (line) reply = `${reply}\n\n${line}`;
    }

    // The reply goes out FIRST. Bookkeeping after this point must never stop
    // the person getting their answer (or make the catch below raise the
    // support request a second time).
    await enqueueWhatsapp({ tenantId: sendTenantId, phone: normalizedPhone, messageBody: reply });
    try {
      await knex('assistant_messages').insert([
        { phone: normalizedPhone, audience, tenant_id: sendTenantId, user_id: agentUser?.id || null, direction: 'inbound', body: String(text).slice(0, 4000) },
        { phone: normalizedPhone, audience, tenant_id: sendTenantId, user_id: agentUser?.id || null, direction: 'outbound', body: reply, action },
      ]);
    } catch (logErr) {
      console.error('[Assistant] could not save chat history (reply already sent):', logErr.message);
    }
    console.log('[Assistant] %s %s action=%s', audience, normalizedPhone, action);
    return { handled: true, action };
  } catch (err) {
    console.error('[Assistant] failed, caller falls back:', err.message);
    // Already raised before the failure: don't raise it again, and the caller
    // must not send its own reply on top of ours.
    if (supportRaised) {
      await enqueueWhatsapp({ tenantId: sendTenantId, phone: normalizedPhone, messageBody: fallbackSupportReply(lang) }).catch(() => {});
      return { handled: true, action: 'support' };
    }
    if (audience === 'agent' && looksLikeSupportRequest(text)) {
      await raiseSupportRequest(knex, { phone: normalizedPhone, name: name || agentUser?.name, audience, kind: 'problem', lastMessage: text, tenantId: sendTenantId, userId: agentUser?.id || null });
      await enqueueWhatsapp({ tenantId: sendTenantId, phone: normalizedPhone, messageBody: fallbackSupportReply(lang) }).catch(() => {});
      return { handled: true, action: 'support' };
    }
    if (await handleSellerWithoutModel(knex, { audience, phone: normalizedPhone, name, text, tenantId, lang })) {
      return { handled: true, action: 'seller_lead' };
    }
    return { handled: false };
  }
}

module.exports = {
  handleWithAssistant,
  parseAssistantOutput,
  formatPlansForPrompt,
  looksLikeSupportRequest,
  isPlainQuestion,
  capShortReply,
  buildSystemPrompt,
  LISTING_STATUS_MEANING,
};
