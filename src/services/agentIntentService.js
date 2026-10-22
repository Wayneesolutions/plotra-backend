// src/services/agentIntentService.js
//
// Natural-language intent layer for messages a registered AGENT sends on
// WhatsApp. Before this, every agent text that wasn't an exact keyword
// ("yes", "payment", "new listing", ...) was treated as listing details and
// fed into the intake/extraction flow — so "meri listings dikhao", "ye plot
// bik gaya", "hello", "plan kitne ka hai" all produced a "Property ka
// address kya hai?" reply. agentReplyIntent.js itself called a real
// intent-classification pass "the v2 fix"; this is that pass.
//
// Design rules (keep these when extending):
// 1. It sits IN FRONT of the existing flows, it doesn't replace them. Every
//    intent ends up calling a handler that already existed (approval,
//    new-listing, receipt flow, status-check buttons) or a small read-only
//    reply (my listings, help, plan info, inventory search).
// 2. Fail open to the old behaviour. LLM error/timeout/low confidence/flag
//    off => decideRoute returns { route: 'intake' } and the message goes to
//    handleAgentIntakeMessage exactly as before.
// 3. Mid-conversation bias. If the agent has a live draft (the bot just
//    asked "price kitni hai?"), a short answer like "55" or "Ludhiana" is
//    listing info. We require higher confidence to route away from intake
//    while a draft is live.
// 4. Nothing destructive happens on the LLM's word alone. "Mark sold" only
//    ever SENDS the existing sold:/available: confirmation buttons; the
//    listing changes only when the agent taps one (existing handler in
//    webhookController.js).
const axios = require('axios');
const { detectReplyLanguage } = require('../utils/replyLanguage');
const { quickAgentIntent } = require('../utils/agentQuickIntent');
const { t } = require('../utils/i18n');
const { getContactVariant } = require('./contactVariantService');
const { billingState, dealerBilling, shortDate } = require('./trialService');

// Required lazily: agentMessagingService opens a BullMQ/Redis connection at
// load time, which would keep the pure-function unit tests from exiting.
const enqueueAgentWhatsappSend = (...a) => require('./agentMessagingService').enqueueAgentWhatsappSend(...a);
const getActivePlansInMenuOrder = (...a) => require('./agentPaymentService').getActivePlansInMenuOrder(...a);
const buildPlanMenuMessage = (...a) => require('./agentPaymentService').buildPlanMenuMessage(...a);
const razorpay = () => require('./razorpayService');
const extractBuyerIntent = (...a) => require('./buyerSearchService').extractBuyerIntent(...a);
const findMatchingListings = (...a) => require('./buyerSearchService').findMatchingListings(...a);
const formatPrice = (...a) => require('./buyerSearchService').formatPrice(...a);
const buildPublicListingUrl = (...a) => require('./buyerSearchService').buildPublicListingUrl(...a);
const handleWithAssistant = (...a) => require('./assistantService').handleWithAssistant(...a);

const INTENTS = [
  'listing_info',   // property details, an answer to the bot's question, or a correction
  'approve',        // approving the preview that is waiting ("haan sab sahi hai, publish karo")
  'new_listing',    // wants to start a different listing
  'my_listings',    // wants to see their own listings
  'mark_sold',      // a property is sold / should be removed
  'mark_available', // a property is still available
  'submit_payment', // has paid / wants to send a receipt
  'plan_info',      // asks about packages, price, due date, payment status
  'search_inventory', // looking for a property for a client
  'help',           // asks for the list of commands / what the bot can do
  'question',       // a real question: how/why something works, what went wrong, what a plan includes
  'support',        // has a problem, complaint, something not working, or wants to talk to a person
  'greeting',       // hi / hello / sat sri akal / thanks
  'other',          // anything else
];

const NON_INTAKE_INTENTS = new Set([
  'my_listings', 'mark_sold', 'mark_available', 'submit_payment', 'plan_info',
  'search_inventory', 'help', 'question', 'support', 'greeting', 'other',
]);

// Confidence needed to route a message AWAY from the listing intake flow.
const MIN_CONFIDENCE_IDLE = 0.6;        // no live draft
const MIN_CONFIDENCE_MID_DRAFT = 0.8;   // bot is waiting on listing details
const MIN_CONFIDENCE_APPROVE = 0.85;    // approval publishes a listing

const LIVE_DRAFT_STATUSES = ['collecting', 'extracting', 'creating', 'enriching', 'awaiting_approval'];
const AGENT_VISIBLE_STATUSES = ['active', 'awaiting_approval', 'pending', 'unconfirmed'];

function isRouterEnabled() {
  const flag = String(process.env.AGENT_INTENT_ROUTER || 'on').toLowerCase();
  return !['off', 'false', '0', 'disabled'].includes(flag);
}

/**
 * Loads the conversational context the classifier needs: the live draft (if
 * any) and the last message the bot sent in it.
 */
async function loadAgentContext(knex, agentUser) {
  const draft = await knex('agent_listing_drafts')
    .where({ user_id: agentUser.id, tenant_id: agentUser.tenant_id })
    .whereIn('status', LIVE_DRAFT_STATUSES)
    .orderBy('updated_at', 'desc')
    .first();

  let lastBotMessage = null;
  if (draft) {
    const last = await knex('agent_draft_messages')
      .where({ draft_id: draft.id, direction: 'outbound' })
      .orderBy('created_at', 'desc')
      .first();
    lastBotMessage = last ? last.body : null;
  }

  return {
    draftStatus: draft ? draft.status : null,
    draftHasContent: Boolean(draft && (draft.accumulated_text || draft.listing_id)),
    lastBotMessage,
  };
}

function buildSystemPrompt(ctx) {
  const state = ctx.draftStatus === 'awaiting_approval'
    ? 'A listing PREVIEW is waiting for the agent to approve or correct it.'
    : ctx.draftStatus && ctx.draftHasContent
      ? 'The agent is in the middle of giving details for a new listing; the bot asked them a follow-up question.'
      : 'No listing is in progress.';

  return `You route WhatsApp messages from a real-estate AGENT to the right feature of Plotraa, an Indian property-listing platform. Agents write in English, Hindi, Punjabi, Hinglish or mixed, with typos, voice-to-text errors and local terms (gaj, marla, kanal, kothi, dukaan, lakh, crore).

Conversation state: ${state}
Last bot message: ${ctx.lastBotMessage ? JSON.stringify(ctx.lastBotMessage.slice(0, 400)) : 'none'}

Intents:
- listing_info: describes a property to list, answers the bot's last question (even a bare "55 lakh", "Ludhiana", "5 marla", "plot"), or corrects the preview ("price galat hai, 60 lakh karo", "haan theek hai but address change karo").
- approve: clearly approves the waiting preview with no change requested ("haan sab sahi hai publish kar do", "looks good go ahead"). Only possible when a preview is waiting.
- new_listing: wants to add another/different property but gives no details yet ("ek aur property daalni hai").
- my_listings: wants to see their listings ("meri listings dikhao", "kitni property live hai").
- mark_sold: says a property is sold or should be removed ("model town wala plot bik gaya", "listing hata do").
- mark_available: confirms a property is still for sale.
- submit_payment: says they have paid or want to send a receipt ("payment kar di", "screenshot bhejta hu").
- plan_info: asks about packages, charges, due date, or their payment status.
- search_inventory: looking for a property for a buyer/client ("koi 200 gaj plot hai dugri mein?").
- help: just asks for the menu / what the bot can do ("help", "kya kya kar sakte ho").
- question: asks HOW or WHY something works, what went wrong, or for an explanation ("pin kyun chahiye?", "preview link kahan hai?", "leads kaise milte hain?", "multi user plan mein kya milta hai?", "listing live kyun nahi hui?").
- support: reports a problem or complaint, says something isn't working, is upset, or wants to talk to a person ("kuch nahi chal raha", "payment kar di par approve nahi hua", "call karo mujhe").
- greeting: only a greeting/thanks/small talk.
- other: none of the above.

When the bot just asked a question and the reply could plausibly be the answer, choose listing_info.

Return ONLY JSON: {"intent": one of ${JSON.stringify(INTENTS)}, "confidence": number 0-1, "listing_hint": string or null (words identifying WHICH existing listing for mark_sold/mark_available, e.g. "model town plot", or a number like "2"; else null), "reply_language": "en" if the agent wrote in plain English, otherwise "hi" (Hindi, Punjabi, Hinglish or any mix)}`;
}

/**
 * Calls the model. Returns null on any failure — callers treat null as
 * "use the old flow".
 */
async function classifyAgentMessage(text, ctx) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: process.env.AGENT_INTENT_MODEL || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        { role: 'system', content: buildSystemPrompt(ctx) },
        { role: 'user', content: String(text).slice(0, 1500) },
      ],
    }, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: Number(process.env.AGENT_INTENT_TIMEOUT_MS || 6000),
    });
    return parseClassification(response.data.choices[0].message.content);
  } catch (err) {
    console.error('agentIntentService: classification failed, falling back to intake flow:', err.message);
    return null;
  }
}

function parseClassification(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || !INTENTS.includes(parsed.intent)) return null;
  const confidence = Number(parsed.confidence);
  return {
    intent: parsed.intent,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    listingHint: typeof parsed.listing_hint === 'string' && parsed.listing_hint.trim() ? parsed.listing_hint.trim() : null,
    replyLanguage: parsed.reply_language === 'en' || parsed.reply_language === 'hi' ? parsed.reply_language : null,
  };
}

/**
 * Pure routing decision (unit-tested). Returns one of:
 *   { route: 'intake' }                      — old flow, unchanged
 *   { route: 'intake', forceApproval: true } — old flow, treat as approval
 *   { route: 'intake', forceNewListing: true }
 *   { route: '<intent>' }                    — handled by this service
 */
function decideRoute(classification, ctx) {
  if (!classification) return { route: 'intake' };
  const { intent, confidence } = classification;
  const midDraft = Boolean(ctx.draftStatus && ctx.draftHasContent);

  if (intent === 'listing_info') return { route: 'intake' };

  if (intent === 'approve') {
    if (ctx.draftStatus === 'awaiting_approval' && confidence >= MIN_CONFIDENCE_APPROVE) {
      return { route: 'intake', forceApproval: true };
    }
    return { route: 'intake' };
  }

  if (intent === 'new_listing') {
    return confidence >= MIN_CONFIDENCE_IDLE ? { route: 'intake', forceNewListing: true } : { route: 'intake' };
  }

  if (NON_INTAKE_INTENTS.has(intent)) {
    const threshold = midDraft ? MIN_CONFIDENCE_MID_DRAFT : MIN_CONFIDENCE_IDLE;
    if (confidence < threshold) return { route: 'intake' };
    // With no listing in progress, "other" still shouldn't open an empty
    // listing draft — reply with help instead. Mid-draft, "other" goes to
    // intake so the existing flow can re-ask its question.
    // Idle "other" goes to the conversational assistant, which can actually
    // talk instead of replying with the fixed menu.
    if (intent === 'other') return midDraft ? { route: 'intake' } : { route: 'assistant' };
    if (intent === 'greeting' && midDraft) return { route: 'intake' };
    return { route: intent };
  }

  return { route: 'intake' };
}

// ---------------------------------------------------------------- listings

async function getAgentListings(knex, agentUser) {
  return knex('listings')
    .where({ tenant_id: agentUser.tenant_id })
    .whereIn('status', AGENT_VISIBLE_STATUSES)
    .whereNull('deleted_at')
    .andWhere((b) => b.where('created_by', agentUser.id).orWhere('assigned_agent_id', agentUser.id))
    .orderBy('created_at', 'desc')
    .limit(20)
    .select('id', 'title', 'status', 'price', 'raw_address', 'general_area', 'property_type', 'plot_area', 'public_slug');
}

const STOP_WORDS = new Set([
  'wala', 'wali', 'wale', 'vala', 'vali', 'the', 'a', 'an', 'in', 'mein', 'me', 'ka', 'ki', 'ke',
  'property', 'listing', 'sold', 'bik', 'gaya', 'gayi', 'gai', 'hata', 'do', 'hai', 'ho', 'my', 'mera', 'meri', 'wo', 'woh', 'ye', 'yeh',
]);

function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ਀-੿\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Pure (unit-tested). Picks which of the agent's listings a hint refers to.
 * A bare number ("2", "2nd") is a 1-based index into the list as shown by
 * "my listings" (same newest-first order). Otherwise scores word overlap
 * against title/address/area/type and returns the best-scoring ones.
 */
function pickListingCandidates(listings, hint) {
  if (!listings.length) return [];
  if (!hint) return listings.length === 1 ? listings : [];

  const indexMatch = String(hint).trim().match(/^#?(\d{1,2})(st|nd|rd|th)?$/i);
  if (indexMatch) {
    const l = listings[Number(indexMatch[1]) - 1];
    return l ? [l] : [];
  }

  const hintTokens = tokenize(hint);
  if (!hintTokens.length) return listings.length === 1 ? listings : [];

  const scored = listings.map((l) => {
    const hay = new Set(tokenize([l.title, l.raw_address, l.general_area, l.property_type, l.plot_area].join(' ')));
    const score = hintTokens.filter((t) => hay.has(t)).length;
    return { l, score };
  }).filter((s) => s.score > 0);

  if (!scored.length) return [];
  const best = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === best).map((s) => s.l);
}

function listingUrl(l) {
  return buildPublicListingUrl(l.public_slug);
}

function formatAgentListingLines(listings) {
  return listings.slice(0, 10).map((l, i) => {
    const badge = l.status === 'active' ? '🟢' : l.status === 'unconfirmed' ? '🟠' : '🕒';
    const where = l.general_area || l.raw_address || '';
    return `${i + 1}. ${badge} *${l.title}* — ${formatPrice(l.price)}${where ? `\n   📍 ${where}` : ''}${l.public_slug ? `\n   ${listingUrl(l)}` : ''}`;
  }).join('\n\n');
}

// WhatsApp interactive button titles are capped at 20 characters.
function buttonTitle(text) {
  const t = String(text || '').trim();
  return t.length <= 20 ? t : `${t.slice(0, 19)}…`;
}

// ---------------------------------------------------------------- replies

async function send(agentUser, messageBody, buttons) {
  await enqueueAgentWhatsappSend({ tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody, buttons });
}

async function replyMyListings(knex, agentUser, lang) {
  const listings = await getAgentListings(knex, agentUser);
  if (!listings.length) {
    return send(agentUser, lang === 'en'
      ? "You don't have any listings yet. Send me property details (type, area, price) and I'll create one."
      : 'Abhi aapki koi listing nahi hai. Property ki details (type, area, price) bhejiye, main listing bana dunga.');
  }
  const more = listings.length > 10 ? (lang === 'en' ? `\n\n…and ${listings.length - 10} more on your dashboard.` : `\n\n…aur ${listings.length - 10} dashboard par.`) : '';
  const footer = lang === 'en'
    ? '\n\nTo mark one sold, just say e.g. "number 2 is sold".'
    : '\n\nKoi bik gayi ho to bas likhein, jaise "number 2 bik gaya".';
  return send(agentUser, `${lang === 'en' ? `📋 Your listings (${listings.length}):` : `📋 Aapki listings (${listings.length}):`}\n\n${formatAgentListingLines(listings)}${more}${footer}`);
}

/**
 * Never changes a listing itself. Sends the existing sold:/available:
 * buttons; the tap is handled by webhookController.js's button branch.
 */
async function replyStatusChange(knex, agentUser, lang, { hint, toSold }) {
  const listings = await getAgentListings(knex, agentUser);
  if (!listings.length) {
    return send(agentUser, lang === 'en' ? "You don't have any live listings right now." : 'Abhi aapki koi live listing nahi hai.');
  }

  const candidates = pickListingCandidates(listings, hint);

  if (candidates.length === 1) {
    const l = candidates[0];
    const body = toSold
      ? (lang === 'en' ? `Mark *${l.title}* as sold? It will be removed from public view.` : `Kya *${l.title}* ko sold mark karna hai? Ye public se hat jayegi.`)
      : (lang === 'en' ? `Confirm *${l.title}* is still available?` : `Kya *${l.title}* abhi bhi available hai?`);
    const buttons = toSold
      ? [{ id: `sold:${l.id}`, title: lang === 'en' ? 'Yes, sold' : 'Haan, bik gayi' }, { id: `available:${l.id}`, title: lang === 'en' ? 'No, available' : 'Nahi, available' }]
      : [{ id: `available:${l.id}`, title: lang === 'en' ? 'Yes, available' : 'Haan, available' }, { id: `sold:${l.id}`, title: lang === 'en' ? 'No, it sold' : 'Nahi, bik gayi' }];
    return send(agentUser, body, buttons);
  }

  if (candidates.length > 1 && candidates.length <= 3) {
    const action = toSold ? 'sold' : 'available';
    return send(agentUser,
      lang === 'en' ? 'Which one do you mean?' : 'Kaunsi property?',
      candidates.map((l) => ({ id: `${action}:${l.id}`, title: buttonTitle(l.title) })));
  }

  const ask = lang === 'en'
    ? `Which listing? Reply with its number, e.g. "number 2 ${toSold ? 'is sold' : 'is available'}".`
    : `Kaunsi listing? Number ke saath likhein, jaise "number 2 ${toSold ? 'bik gaya' : 'available hai'}".`;
  return send(agentUser, `${ask}\n\n${formatAgentListingLines(listings)}`);
}

/**
 * "plan" / "mera plan" / "trial kab tak": the LIVE plan list (or the dealer's
 * own plan), their status and the trial end date. 22 Oct: the list used to
 * come from the old hardcoded packages table; the trial end date was not
 * shown anywhere in the chat.
 */
async function replyPlanInfo(knex, agentUser, v) {
  const plans = await getActivePlansInMenuOrder(knex);
  const own = billingState(agentUser, { hasApprovedPayment: agentUser.payment_status === 'paid' });
  // A sub-dealer shares their dealer's trial / payment state.
  const shared = agentUser.role === 'agent' && !agentUser.trial_ends_at ? await dealerBilling(knex, agentUser.tenant_id) : null;
  const billing = shared && shared.status !== 'none' ? shared : own;
  const trialLine = billing.status === 'trial'
    ? t('trial_line', v, { date: shortDate(billing.trial_ends_at), days: t('trial_days_left', v, { n: billing.days_left }) })
    : '';

  const planKey = agentUser.selected_plan_key || (shared?.user?.selected_plan_key) || null;
  const current = planKey ? (plans.find((p) => p.key === planKey) || await knex('plans').where({ key: planKey }).first()) : null;

  if (!current) {
    if (!plans.length) return send(agentUser, t('plan_none', v));
    return send(agentUser, `${buildPlanMenuMessage(plans, v)}${trialLine}`);
  }

  const statusLabel = agentUser.payment_status === 'pending_review' ? t('status_pending_review', v)
    : billing.status === 'paid' ? t('status_paid', v)
      : billing.status === 'trial' ? t('status_trial', v)
        : billing.status === 'expired' ? t('status_expired', v)
          : (agentUser.payment_status === 'paid' ? t('status_paid', v) : t('status_unpaid', v));

  let pay = '';
  if (billing.status !== 'paid' && agentUser.payment_status !== 'paid') {
    pay = t('plan_pay_receipt', v);
    if (agentUser.role === 'owner' && razorpay().isConfigured()) {
      try {
        const { url } = await razorpay().getOrCreatePaymentLink(knex, { user: agentUser, planKey: current.key });
        pay = `${t('plan_pay_link', v, { link: url })}\n${pay}`;
      } catch (err) {
        console.error('agentIntentService: payment link failed (showing QR/receipt text):', err.message);
        if (current.qr_code_url) pay = `QR: ${current.qr_code_url}\n${pay}`;
      }
    } else if (current.qr_code_url) {
      pay = `QR: ${current.qr_code_url}\n${pay}`;
    }
  }
  return send(agentUser, t('plan_current', v, {
    plan: current.label, price: Number(current.price_inr).toLocaleString('en-IN'), status: statusLabel, trial: trialLine, pay,
  }).trim());
}

/**
 * An agent looking for a property for their client. Searches the agent's
 * OWN tenant's inventory only, and does not log marketplace lead
 * deliveries (those are buyer-sourced leads used for billing). Widening
 * this to cross-dealer search is a business decision, not a code one.
 */
async function replyInventorySearch(knex, agentUser, lang, text) {
  const intent = await extractBuyerIntent(text);
  if (!intent) {
    return send(agentUser, lang === 'en'
      ? 'What are you looking for? Tell me the type and area, e.g. "200 gaj plot in Dugri".'
      : 'Kya dhundh rahe hain? Type aur area batayein, jaise "Dugri mein 200 gaj plot".');
  }
  const matches = await findMatchingListings(knex, intent, { tenantId: agentUser.tenant_id });
  if (!matches.length) {
    const what = [intent.propertyType, intent.area].filter(Boolean).join(', ');
    return send(agentUser, lang === 'en'
      ? `No matching listings in your inventory${what ? ` for ${what}` : ''} right now.`
      : `Aapki inventory mein abhi${what ? ` ${what} ke liye` : ''} koi matching listing nahi hai.`);
  }
  const lines = matches.map((l, i) => `${i + 1}. *${l.title}* — ${formatPrice(l.price)}${l.plot_area ? ` · ${l.plot_area}` : ''}\n   ${listingUrl(l)}`).join('\n\n');
  return send(agentUser, `${lang === 'en' ? `🔎 Found ${matches.length}:` : `🔎 ${matches.length} mili:`}\n\n${lines}\n\n${lang === 'en' ? 'Forward these links to your client.' : 'Ye links client ko forward kar dein.'}`);
}

/**
 * Entry point from webhookController.js for an agent's plain text message.
 * Returns a decision object:
 *   { handled: true }                          — reply already queued
 *   { handled: false, forceApproval?, forceNewListing? } — caller runs the
 *     existing intake flow, passing the flags through
 *   { handled: false, delegate: 'receipt' }  — caller runs the existing
 *     receipt-submission handler
 * Never throws.
 */
async function routeAgentText(knex, { agentUser, incomingText }) {
  if (!isRouterEnabled()) return { handled: false };

  let ctx;
  let decision;
  let classification = null;
  try {
    ctx = await loadAgentContext(knex, agentUser);
    // Clear-cut messages (an address, a payment problem, "support number?",
    // "discount?") are settled without the model so an old open draft can't
    // swallow them or the model can't misread them.
    const quick = quickAgentIntent(incomingText, { draftOpen: Boolean(ctx.draftStatus) });
    if (quick === 'listing_info') {
      classification = { intent: 'listing_info', confidence: 1, listingHint: null, replyLanguage: null };
    } else if (quick) {
      classification = { intent: quick, confidence: 1, listingHint: null, replyLanguage: null };
    } else {
      classification = await classifyAgentMessage(incomingText, ctx);
    }
    decision = decideRoute(classification, ctx);
  } catch (err) {
    console.error('agentIntentService: routing failed, using intake flow:', err.message);
    return { handled: false };
  }

  console.log('[AgentIntent] agent=%s intent=%s conf=%s draft=%s route=%s',
    agentUser.id, classification?.intent || 'none', classification?.confidence ?? '-', ctx.draftStatus || 'none', decision.route);

  if (decision.route === 'intake') {
    return { handled: false, forceApproval: Boolean(decision.forceApproval), forceNewListing: Boolean(decision.forceNewListing) };
  }

  const lang = classification.replyLanguage || detectReplyLanguage(incomingText);
  // Fixed replies (greeting, help, plan list) are written in the script of
  // THIS message: a Gurmukhi message gets Gurmukhi, not Roman (22 Oct bug C).
  const v = await getContactVariant(knex, agentUser.phone, incomingText);
  try {
    switch (decision.route) {
      case 'my_listings':
        await replyMyListings(knex, agentUser, lang); break;
      case 'mark_sold':
        await replyStatusChange(knex, agentUser, lang, { hint: classification.listingHint, toSold: true }); break;
      case 'mark_available':
        await replyStatusChange(knex, agentUser, lang, { hint: classification.listingHint, toSold: false }); break;
      case 'submit_payment':
        // Existing receipt flow (arms awaiting_receipt_submission); the
        // caller runs it so it can own the HTTP response as before.
        return { handled: false, delegate: 'receipt' };
      case 'plan_info':
        await replyPlanInfo(knex, agentUser, v); break;
      case 'search_inventory':
        await replyInventorySearch(knex, agentUser, lang, incomingText); break;
      case 'question':
      case 'support':
      case 'assistant': {
        const answered = await handleWithAssistant(knex, { audience: 'agent', phone: agentUser.phone, text: incomingText, agentUser });
        if (!answered.handled) await send(agentUser, t('agent_help', v));
        break;
      }
      case 'greeting':
        await send(agentUser, t('agent_greeting', v, { name: agentUser.name ? ` ${String(agentUser.name).split(' ')[0]}${v === 'hi' ? ' ji' : ''}` : '' })); break;
      case 'help':
      default:
        await send(agentUser, t('agent_help', v)); break;
    }
    return { handled: true, route: decision.route };
  } catch (err) {
    console.error(`agentIntentService: handler ${decision.route} failed, using intake flow:`, err.message);
    return { handled: false };
  }
}

module.exports = {
  routeAgentText,
  decideRoute,
  parseClassification,
  pickListingCandidates,
  buttonTitle,
  INTENTS,
};
