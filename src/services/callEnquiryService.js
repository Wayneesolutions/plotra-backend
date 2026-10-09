// src/services/callEnquiryService.js
//
// Closes the gap between "the AI answered a buyer's call" and "the buyer
// got matching properties on WhatsApp":
//
//   inbound call ends on WayneRing
//     -> wayneRingSyncService.syncInboundCalls (webhook-triggered or polled)
//     -> processCallEnquiry: read the transcript, pull out what the caller
//        wants and which number to WhatsApp, match active listings, store a
//        call_enquiries row, send the approved WhatsApp template
//     -> buyer taps the template's button / replies "yes"
//     -> handleCallEnquiryReply (called from webhookController.js): the 24h
//        service window is now open, so the listing links go out as a
//        normal text message.
//
// Why two WhatsApp steps instead of just sending the links: the buyer
// phoned, they never messaged — so there is no open service window, and
// Meta only allows a pre-approved template as the first message. Template
// variables cannot hold line breaks, so a list of listings cannot ride in
// the template itself. The template announces the matches; the reply
// unlocks the free-form message that carries them.
//
// Matching reuses buyerSearchService.js (the WhatsApp marketplace search)
// rather than a second implementation: same filters, same reply format,
// same marketplace_lead_deliveries logging.
const axios = require('axios');
const { Queue } = require('bullmq');
const { normalizePhone } = require('../utils/phone');
const { findMatchingListings, formatSearchReply, logDeliveries } = require('./buyerSearchService');

const PROPERTY_TYPES = ['Plot', 'House', 'Villa', 'Flat', 'Commercial', 'Agricultural Land'];
const INTENTS = ['buy', 'rent', 'sell', 'other'];

// A call older than this when it is first seen gets recorded but never
// triggers a WhatsApp message. Without it, the first deploy would walk
// WayneRing's last 50 inbound calls and message people who phoned days ago.
const MAX_CALL_AGE_MINUTES = Number(process.env.CALL_ENQUIRY_MAX_AGE_MINUTES) || 60;

// How long after the template a "yes"/button tap still unlocks the listings.
const REPLY_WINDOW_DAYS = Number(process.env.CALL_ENQUIRY_REPLY_WINDOW_DAYS) || 7;

// Calls this short with no transcript are hang-ups, not enquiries.
const MIN_ENQUIRY_DURATION_SECONDS = 8;

const NON_ENQUIRY_OUTCOMES = new Set(['NO_ANSWER', 'FAILED', 'VOICEMAIL']);

const BUTTON_PAYLOAD_PREFIX = 'call_enquiry:';

// Lazily created: requiring this module (e.g. from a unit test, or from the
// API process on a route that never sends) must not open a Redis connection.
let whatsappOutboundQueue = null;
function getOutboundQueue() {
  if (!whatsappOutboundQueue) {
    whatsappOutboundQueue = new Queue('whatsapp-outbound', {
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(times * 200, 5000),
        connectTimeout: 3000,
      },
    });
  }
  return whatsappOutboundQueue;
}

/**
 * WayneRing stores an inbound call's transcript as JSON — either Vapi's
 * message array ([{ role, message }]) or, on older rows, a plain string /
 * empty array. Flattens whichever shape arrives into "Caller: … / Agent: …"
 * lines for the extraction prompt.
 */
function transcriptToText(transcript) {
  if (!transcript) return '';
  if (typeof transcript === 'string') return transcript.trim();
  if (!Array.isArray(transcript)) return '';

  return transcript
    .map((turn) => {
      if (!turn) return null;
      const text = turn.message || turn.content || turn.text || turn.transcript;
      if (!text || typeof text !== 'string') return null;
      const role = String(turn.role || '').toLowerCase();
      if (role === 'system' || role === 'tool' || role === 'function' || role.startsWith('tool_call')) return null;
      const speaker = (role === 'user' || role === 'customer' || role === 'caller') ? 'Caller' : 'Agent';
      return `${speaker}: ${text.trim()}`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Validates a phone number the caller SPOKE on the call. Speech-to-text
 * regularly drops or doubles a digit, so this is strict on purpose: only a
 * well-formed Indian mobile number is accepted. Anything else returns null
 * and the caller-ID fallback in resolveWhatsappPhone takes over — a
 * template sent to a wrong number reaches a stranger.
 */
function normalizeSpokenIndianMobile(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

function parsePhoneList(envValue) {
  return String(envValue || '')
    .split(',')
    .map((n) => normalizePhone(n.trim()))
    .filter(Boolean);
}

/**
 * Decides which number gets the WhatsApp message.
 *
 * 1. A valid number the caller spoke on the call wins — they were asked
 *    "which WhatsApp number should I send these to?".
 * 2. Otherwise the caller ID, unless it is one of our own lines. When a
 *    call reaches the AI through carrier call-forwarding, some operators
 *    pass the forwarding line's number as the caller ID instead of the
 *    buyer's; CALL_FORWARDING_SOURCE_NUMBERS lists those lines so we never
 *    WhatsApp ourselves.
 */
function resolveWhatsappPhone({ spokenNumber, callerPhone, excludedNumbers = [] }) {
  const spoken = normalizeSpokenIndianMobile(spokenNumber);
  if (spoken && !excludedNumbers.includes(spoken)) return { phone: spoken, source: 'spoken' };

  const caller = normalizePhone(callerPhone);
  if (caller && /^\+\d{10,15}$/.test(caller) && !excludedNumbers.includes(caller)) {
    return { phone: caller, source: 'caller_id' };
  }

  return { phone: null, source: null };
}

function cleanString(value, maxLength) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || /^(null|none|n\/a|unknown|not (mentioned|specified|provided))$/i.test(text)) return null;
  return text.slice(0, maxLength);
}

/**
 * Coerces the model's JSON into the shape the rest of this module trusts:
 * known vocabulary only for intent/property_type, trimmed strings, real
 * booleans. Returns null when the call was not a property enquiry.
 */
function normalizeExtraction(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.is_property_enquiry !== true) return null;

  const propertyTypeRaw = cleanString(parsed.property_type, 50);
  const propertyType = propertyTypeRaw
    ? PROPERTY_TYPES.find((t) => t.toLowerCase() === propertyTypeRaw.toLowerCase()) || null
    : null;

  const intentRaw = cleanString(parsed.intent, 20);
  const intent = intentRaw && INTENTS.includes(intentRaw.toLowerCase()) ? intentRaw.toLowerCase() : null;

  return {
    intent,
    propertyType,
    area: cleanString(parsed.area, 255),
    budgetText: cleanString(parsed.budget_text, 100),
    sizeText: cleanString(parsed.size_text, 100),
    timelineText: cleanString(parsed.timeline_text, 100),
    buyerName: cleanString(parsed.buyer_name, 255),
    spokenWhatsappNumber: cleanString(parsed.whatsapp_number, 30),
    whatsappConsent: typeof parsed.whatsapp_consent === 'boolean' ? parsed.whatsapp_consent : null,
  };
}

const EXTRACTION_SYSTEM_PROMPT = `You read the transcript of a phone call between a property buyer and an AI agent for an Indian real estate platform. The call may be in Hindi, Punjabi, English or a mix, and the transcript comes from speech-to-text so spelling is imperfect.

Extract what the caller wants. Respond with ONLY a JSON object, no other text:
{
  "is_property_enquiry": boolean,     // true only if the caller asked about buying, renting or selling property
  "intent": string or null,           // one of: buy, rent, sell, other
  "property_type": string or null,    // one of: Plot, House, Villa, Flat, Commercial, Agricultural Land (kothi/makaan = House, dukaan/shop/showroom/office = Commercial, zameen for farming = Agricultural Land)
  "area": string or null,             // locality / road / city the caller wants, in plain English spelling, most specific name only (e.g. "Sarabha Nagar")
  "budget_text": string or null,      // budget as said, e.g. "50 lakh", "1.2 crore"
  "size_text": string or null,        // size as said, e.g. "200 gaj", "3 BHK", "10 marla"
  "timeline_text": string or null,    // when they want to buy/move, as said
  "buyer_name": string or null,       // the caller's own name if they gave it
  "whatsapp_number": string or null,  // the WhatsApp number the caller asked listings to be sent to, DIGITS ONLY. Convert spoken number words in any language to digits ("nau aath saat" -> "987", "double five" -> "55"). Use the final number the agent read back and the caller confirmed. null if the caller gave no number or said to use the number they are calling from.
  "whatsapp_consent": boolean or null // true if the caller agreed to receive listings on WhatsApp, false if they refused, null if it never came up
}

Never guess. If a field was not said on the call, use null. If is_property_enquiry is false, set every other field to null.`;

/**
 * Asks the model what the caller wanted. Throws on a transport/API failure
 * (so the caller can leave the call unprocessed and retry on the next sync
 * tick) and returns null only when the call genuinely was not an enquiry.
 */
async function extractCallEnquiry({ transcriptText, summary }) {
  const parts = [];
  if (summary) parts.push(`CALL SUMMARY:\n${summary}`);
  if (transcriptText) parts.push(`TRANSCRIPT:\n${transcriptText.slice(0, 12000)}`);
  if (parts.length === 0) return { extraction: null, raw: null };

  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: parts.join('\n\n') },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  }, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    timeout: 20000,
  });

  const raw = JSON.parse(response.data.choices[0].message.content);
  return { extraction: normalizeExtraction(raw), raw };
}

/**
 * WhatsApp rejects a template whose variable contains a newline, a tab or
 * more than four consecutive spaces — and an empty variable too.
 */
function sanitizeTemplateParam(value, fallback) {
  const text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return (text || fallback).slice(0, 120);
}

/** "Plot in Sarabha Nagar" — the human-readable requirement, for the template and the dashboard. */
function describeRequirement({ propertyType, area, sizeText }) {
  const what = [sizeText, propertyType].filter(Boolean).join(' ') || 'property';
  return area ? `${what} in ${area}` : what;
}

function buildTemplateJob({ enquiryId, tenantId, phone, buyerName, matchCount, requirement }) {
  const templateName = process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME;
  if (!templateName) return null;

  return {
    tenantId: tenantId || null,
    phone,
    // Logged as the message body wherever a send is recorded; the template
    // itself is what the buyer actually sees.
    messageBody: `[template:${templateName}] ${matchCount} matching properties for ${requirement}`,
    template: {
      name: templateName,
      lang: process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_LANG || 'en',
      bodyParams: [
        sanitizeTemplateParam(buyerName, 'there'),
        sanitizeTemplateParam(matchCount, '0'),
        sanitizeTemplateParam(requirement, 'your enquiry'),
      ],
      // Echoed back by Meta when the buyer taps the template's quick-reply
      // button — see handleCallEnquiryReply.
      quickReplyPayload: `${BUTTON_PAYLOAD_PREFIX}${enquiryId}`,
    },
  };
}

function callAgeMinutes(call, now = new Date()) {
  const reference = call.endedAt || call.startedAt || call.createdAt;
  const time = reference ? new Date(reference).getTime() : NaN;
  if (Number.isNaN(time)) return null;
  return (now.getTime() - time) / 60000;
}

/**
 * Processes one finished inbound WayneRing call. Idempotent on the call id:
 * safe to call on every sync tick for every call in the list.
 *
 * `call` is a WayneRing InboundCall row as returned by GET /api/inbound/calls
 * (id, callerNumber, summary, transcript, recordingUrl, outcome,
 * durationSeconds, startedAt, endedAt).
 *
 * tenantId/leadId are set for a call on a dealer's own number and null for
 * a call on the shared platform line.
 *
 * Returns { status } describing what happened, or { status: 'already_processed' }.
 */
async function processCallEnquiry(knex, { call, tenantId = null, leadId = null }, deps = {}) {
  const extract = deps.extract || extractCallEnquiry;
  const enqueue = deps.enqueue || ((job) => getOutboundQueue().add('send-call-enquiry-template', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  }));
  const now = deps.now || new Date();

  const providerCallId = String(call.id);

  const existing = await knex('call_enquiries').where({ provider_call_id: providerCallId }).first('id');
  if (existing) return { status: 'already_processed' };

  const callerPhone = normalizePhone(call.callerNumber || call.callerPhone || call.from || call.phone);
  const baseRow = {
    provider_call_id: providerCallId,
    tenant_id: tenantId,
    lead_id: leadId,
    caller_phone: callerPhone,
    summary: call.summary || null,
    recording_url: call.recordingUrl || call.recording_url || null,
    call_started_at: call.startedAt || call.createdAt || null,
  };

  const insertRow = async (row) => {
    // onConflict().ignore(): two sync runs (webhook + poller) can reach the
    // same call at the same moment — whoever inserts first owns it.
    const inserted = await knex('call_enquiries')
      .insert({ ...baseRow, ...row })
      .onConflict('provider_call_id')
      .ignore()
      .returning(['id']);
    return inserted[0] || null;
  };

  // Old call seen for the first time (first deploy / long outage): keep a
  // record, spend nothing on extraction, message nobody.
  const ageMinutes = callAgeMinutes(call, now);
  if (ageMinutes != null && ageMinutes > MAX_CALL_AGE_MINUTES) {
    await insertRow({ whatsapp_status: 'skipped_stale' });
    return { status: 'skipped_stale' };
  }

  const transcriptText = transcriptToText(call.transcript);
  const duration = call.durationSeconds ?? call.duration_seconds ?? 0;
  const noConversation = NON_ENQUIRY_OUTCOMES.has(call.outcome)
    || (!transcriptText && !call.summary)
    || (!transcriptText && duration < MIN_ENQUIRY_DURATION_SECONDS);

  if (noConversation) {
    await insertRow({ whatsapp_status: 'not_an_enquiry' });
    return { status: 'not_an_enquiry' };
  }

  // Network call — deliberately outside any DB transaction. A failure here
  // throws and nothing is inserted, so the next sync tick tries again
  // (bounded by MAX_CALL_AGE_MINUTES above).
  const { extraction, raw } = await extract({ transcriptText, summary: call.summary });

  if (!extraction) {
    await insertRow({ whatsapp_status: 'not_an_enquiry', raw_extraction: raw ? JSON.stringify(raw) : null });
    return { status: 'not_an_enquiry' };
  }

  const { phone: whatsappPhone } = resolveWhatsappPhone({
    spokenNumber: extraction.spokenWhatsappNumber,
    callerPhone,
    excludedNumbers: parsePhoneList(process.env.CALL_FORWARDING_SOURCE_NUMBERS),
  });

  // A requirement with neither a type nor an area would match every active
  // listing on the platform — same rule buyerSearchService applies.
  const searchable = Boolean(extraction.propertyType || extraction.area);
  const listings = searchable
    ? await findMatchingListings(knex, { propertyType: extraction.propertyType, area: extraction.area }, { tenantId })
    : [];

  let whatsappStatus;
  if (extraction.whatsappConsent === false) whatsappStatus = 'no_consent';
  else if (!whatsappPhone) whatsappStatus = 'no_whatsapp_number';
  else if (listings.length === 0) whatsappStatus = 'no_match';
  else if (!process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME) whatsappStatus = 'skipped_no_template';
  else whatsappStatus = 'pending';

  const row = await insertRow({
    whatsapp_phone: whatsappPhone,
    buyer_name: extraction.buyerName,
    intent: extraction.intent,
    property_type: extraction.propertyType,
    area: extraction.area,
    budget_text: extraction.budgetText,
    size_text: extraction.sizeText,
    timeline_text: extraction.timelineText,
    whatsapp_consent: extraction.whatsappConsent,
    raw_extraction: JSON.stringify(raw),
    match_count: listings.length,
    matched_listing_ids: listings.map((l) => l.id),
    whatsapp_status: whatsappStatus,
  });

  if (!row) return { status: 'already_processed' }; // lost the race to a concurrent sync

  // The dealer's lead row was created with a phone number only; give it the
  // caller's name now that we have one.
  // leads is a deny-by-default RLS table, so this one write runs in its own
  // short service-context transaction (same pattern as wayneRingSyncService).
  // whereNotNull('phone'): the shared anonymous-caller lead (withheld
  // caller ID) stands for many different people and must stay nameless.
  if (leadId && extraction.buyerName) {
    await knex.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.is_service_context', 'true', true)");
      await trx('leads').where({ id: leadId }).whereNull('name').whereNotNull('phone').update({ name: extraction.buyerName, updated_at: trx.fn.now() });
    });
  }

  if (whatsappStatus === 'skipped_no_template') {
    console.warn(`[callEnquiry] ${listings.length} listing(s) matched call ${providerCallId} but WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME is not set — nothing sent. Approve the template in Meta and set the env var.`);
  }

  if (whatsappStatus !== 'pending') return { status: whatsappStatus, enquiryId: row.id, matchCount: listings.length };

  const job = buildTemplateJob({
    enquiryId: row.id,
    tenantId,
    phone: whatsappPhone,
    buyerName: extraction.buyerName,
    matchCount: listings.length,
    requirement: describeRequirement(extraction),
  });

  try {
    await enqueue(job);
    await knex('call_enquiries').where({ id: row.id }).update({
      whatsapp_status: 'template_sent',
      template_sent_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
    return { status: 'template_sent', enquiryId: row.id, matchCount: listings.length };
  } catch (err) {
    console.error(`[callEnquiry] could not queue WhatsApp template for call ${providerCallId}:`, err.message);
    await knex('call_enquiries').where({ id: row.id }).update({ whatsapp_status: 'failed', updated_at: knex.fn.now() });
    return { status: 'failed', enquiryId: row.id, matchCount: listings.length };
  }
}

const AFFIRMATIVE_WORDS = new Set([
  'yes', 'yeah', 'yep', 'ya', 'y', 'ok', 'okay', 'sure', 'show', 'send', 'please', 'pls',
  'haan', 'han', 'ha', 'haanji', 'hanji', 'ji', 'theek', 'thik', 'bhejo', 'bhej', 'bhejdo',
  'dikhao', 'dikha', 'dikhado', 'dedo', 'do', 'kardo', 'karo', 'properties', 'property', 'listings',
  'हाँ', 'हां', 'जी', 'भेजो', 'दिखाओ', 'ਹਾਂ', 'ਜੀ', 'ਭੇਜੋ', 'ਦਿਖਾਓ',
]);

/**
 * True for a short "yes / haan ji / bhejo / show properties" style reply.
 * Deliberately narrow (4 words max, every word affirmative): a buyer who
 * instead types a fresh search ("plots in Model Town") must fall through
 * to the normal marketplace search, not be handed the listings from their
 * earlier call.
 */
function isAffirmativeReply(text) {
  if (!text) return false;
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return words.every((w) => AFFIRMATIVE_WORDS.has(w));
}

/**
 * Called from webhookController.js for every inbound buyer WhatsApp
 * message. If this phone has a call-enquiry template waiting on a reply
 * and the message is the template's button tap (or a plain "yes"), returns
 * { replyText, tenantId, enquiryId, matchCount } and marks the enquiry
 * answered; otherwise returns null and the webhook carries on exactly as
 * before.
 */
async function handleCallEnquiryReply(knex, { phone, incomingText, buttonPayload }) {
  const buyerPhone = normalizePhone(phone);
  if (!buyerPhone) return null;

  const payloadEnquiryId = buttonPayload && String(buttonPayload).startsWith(BUTTON_PAYLOAD_PREFIX)
    ? String(buttonPayload).slice(BUTTON_PAYLOAD_PREFIX.length)
    : null;

  if (!payloadEnquiryId && !isAffirmativeReply(incomingText)) return null;

  const pendingQuery = knex('call_enquiries')
    .where({ whatsapp_phone: buyerPhone, whatsapp_status: 'template_sent' })
    .andWhere('template_sent_at', '>=', knex.raw(`NOW() - INTERVAL '${REPLY_WINDOW_DAYS} days'`))
    .orderBy('template_sent_at', 'desc');

  // A button tap names its enquiry — but only honour it for the phone it
  // was sent to (the id is a uuid; anything else in the payload matches nothing).
  if (payloadEnquiryId && /^[0-9a-f-]{36}$/i.test(payloadEnquiryId)) {
    pendingQuery.andWhere({ id: payloadEnquiryId });
  }

  const enquiry = await pendingQuery.first();
  if (!enquiry) return null;

  // Re-run the match now rather than replaying the ids stored at call time:
  // a listing sold or approved in between should be reflected.
  const intent = { propertyType: enquiry.property_type, area: enquiry.area, sizeText: enquiry.size_text };
  const listings = await findMatchingListings(knex, intent, { tenantId: enquiry.tenant_id });

  // Claim it: only the request that flips template_sent -> listings_sent
  // sends, so a double tap cannot produce two copies.
  const claimed = await knex('call_enquiries')
    .where({ id: enquiry.id, whatsapp_status: 'template_sent' })
    .update({
      whatsapp_status: 'listings_sent',
      listings_sent_at: knex.fn.now(),
      match_count: listings.length,
      matched_listing_ids: listings.map((l) => l.id),
      updated_at: knex.fn.now(),
    });
  if (!claimed) return null;

  await logDeliveries(knex, listings, buyerPhone, `[ai call] ${describeRequirement(intent)}`);

  return {
    replyText: formatSearchReply(listings, intent),
    tenantId: enquiry.tenant_id,
    enquiryId: enquiry.id,
    matchCount: listings.length,
  };
}

module.exports = {
  processCallEnquiry,
  handleCallEnquiryReply,
  extractCallEnquiry,
  // exported for tests
  transcriptToText,
  normalizeSpokenIndianMobile,
  resolveWhatsappPhone,
  normalizeExtraction,
  sanitizeTemplateParam,
  describeRequirement,
  buildTemplateJob,
  isAffirmativeReply,
  parsePhoneList,
  BUTTON_PAYLOAD_PREFIX,
  MAX_CALL_AGE_MINUTES,
};
