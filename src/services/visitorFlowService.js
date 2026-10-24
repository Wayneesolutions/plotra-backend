// src/services/visitorFlowService.js
//
// Carries out the role flow for people who message the Plotraa platform
// number (decision logic: visitorFlowMachine.js). This file owns the parts
// that touch the world: the saved conversation state, seller leads, the
// buyer search, the dealer join request, the assistant for in-flow questions,
// and sending the replies.
//
// Called from webhookController.js for a number that is not a registered
// dealer/agent, on the platform number (not a dealer's own number).
// VISITOR_FLOW=off switches it off (the old assistant-only behaviour).

const { normalizePhone } = require('../utils/phone');
const { t } = require('../utils/i18n');
const { detectScript } = require('../utils/replyLanguage');
const { decide, acceptsPhoto, afterPhoto, ownerHintPatch, TRIAL_DAYS } = require('./visitorFlowMachine');
const { SUPPORT_NUMBER, PUBLIC_SITE } = require('../assistant/plotraaKnowledge');

// Heavy modules are required lazily: they open Redis connections at load time.
const enqueueWhatsapp = (...a) => require('./agentMessagingService').enqueueAgentWhatsappSend(...a);
const handleWithAssistant = (...a) => require('./assistantService').handleWithAssistant(...a);
const raiseSupportRequest = (...a) => require('./supportRequestService').raiseSupportRequest(...a);
const signupService = () => require('./agentSignupService');
const paymentService = () => require('./agentPaymentService');
const buyerSearch = () => require('./buyerSearchService');

const FRESH_AFTER_MS = { open: 3 * 24 * 60 * 60 * 1000, done: 30 * 24 * 60 * 60 * 1000 };

function isEnabled() {
  return String(process.env.VISITOR_FLOW || 'on').toLowerCase() !== 'off';
}

// ------------------------------------------------------------------- state

async function loadState(knex, phone, now = new Date()) {
  const row = await knex('whatsapp_conversations').where({ phone }).first();
  if (!row) return null;
  const age = now.getTime() - new Date(row.updated_at).getTime();
  const limit = row.step === 'done' ? FRESH_AFTER_MS.done : FRESH_AFTER_MS.open;
  if (age > limit) return null; // long silence: start again with the role menu
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  return { role: row.role, step: row.step, data: { done: {}, ...data } };
}

async function saveState(knex, phone, state) {
  await knex.raw(
    `INSERT INTO whatsapp_conversations (phone, role, step, data, updated_at)
     VALUES (?, ?, ?, ?::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET role = EXCLUDED.role, step = EXCLUDED.step, data = EXCLUDED.data, updated_at = NOW()`,
    [phone, state.role, state.step, JSON.stringify(state.data || {})],
  );
}

async function loadCityNames(knex) {
  try {
    return await knex('cities').whereNot({ status: 'disabled' }).pluck('name');
  } catch {
    return [];
  }
}

/** The person's join request, if any, for starting the dealer flow. */
async function loadSignupContext(knex, phone) {
  try {
    const pending = await knex('pending_agent_signups').where({ phone, status: 'pending' }).orderBy('created_at', 'desc').first('name', 'address');
    if (pending) return { status: 'pending', name: pending.name, address: pending.address };
    const rejected = await knex('pending_agent_signups').where({ phone, status: 'rejected' }).orderBy('updated_at', 'desc').first('id');
    if (rejected) return { status: 'rejected' };
  } catch (err) {
    console.error('[VisitorFlow] could not read signup state:', err.message);
  }
  return null;
}

// ------------------------------------------------------------------ output

/** Renders a reply item ({ key, vars, then }) to text; vars may be nested items. */
function render(item, v) {
  const vars = {};
  for (const [k, val] of Object.entries(item.vars || {})) {
    if (val && typeof val === 'object' && val.key) vars[k] = render(val, v);
    else if (val === '__support__') vars[k] = SUPPORT_NUMBER;
    else if (val === '__sell_url__') vars[k] = `${PUBLIC_SITE}/sell-property`;
    else vars[k] = val;
  }
  const text = t(item.key, v, vars);
  return item.then ? `${text}\n\n${render(item.then, v)}` : text;
}

async function logTurn(knex, { phone, direction, body, action = null }) {
  try {
    // In its own savepoint: a failed log write must never abort the webhook's transaction.
    await knex.transaction((tx) => tx('assistant_messages').insert({
      phone, audience: 'visitor', tenant_id: null, user_id: null, direction, body: String(body).slice(0, 4000), action,
    }));
  } catch (err) {
    console.error('[VisitorFlow] could not save chat history:', err.message);
  }
}

async function sendText(knex, phone, body, action = 'flow') {
  await enqueueWhatsapp({ tenantId: null, phone, messageBody: body });
  await logTurn(knex, { phone, direction: 'outbound', body, action });
}

// ----------------------------------------------------------------- effects

async function syncSellerLead(knex, { phone, name, state, effect }) {
  const data = effect.data || state.data;
  let id = state.data.seller_lead_id || null;
  let lead = id ? await knex('seller_leads').where({ id }).first('*') : null;
  if (lead && lead.status !== 'new') lead = null;

  const fields = {
    property_type: data.type || null,
    size_text: data.size || null,
    locality: data.locality || null,
    city: data.city || null,
    expected_price: data.price_text || null,
    photo_urls: data.photo_urls?.length ? JSON.stringify(data.photo_urls) : null,
  };

  if (effect.hintsOnly) {
    // After the flow ended: extra details only fill blanks on the latest open lead.
    if (!lead) {
      lead = await knex('seller_leads').where({ phone, status: 'new' }).orderBy('created_at', 'desc').first('*');
      if (!lead) return;
    }
    const patch = {};
    for (const [k, val] of Object.entries(fields)) if (val && !lead[k]) patch[k] = val;
    if (Object.keys(patch).length) await knex('seller_leads').where({ id: lead.id }).update({ ...patch, updated_at: knex.fn.now() });
    return;
  }

  const description = effect.final
    ? `Via WhatsApp (step-by-step): ${[fields.property_type, fields.size_text, [fields.locality, fields.city].filter(Boolean).join(', '), fields.expected_price].filter(Boolean).join(' · ')}`.slice(0, 2000)
    : 'Via WhatsApp (step-by-step, still answering)';

  if (!lead) {
    const [row] = await knex('seller_leads').insert({
      name: name || 'WhatsApp contact', phone, source: 'whatsapp', description, ...fields,
    }).returning(['id']);
    id = row.id;
    state.data.seller_lead_id = id;
    await saveState(knex, phone, state); // remember which lead this conversation is filling
    return;
  }
  const patch = { description, updated_at: knex.fn.now() };
  for (const [k, val] of Object.entries(fields)) if (val) patch[k] = val;
  await knex('seller_leads').where({ id: lead.id }).update(patch);
}

async function sendPlanList(knex, { phone, v }) {
  const plans = await paymentService().getActivePlansInMenuOrder(knex);
  const body = plans.length
    ? paymentService().buildPlanMenuMessage(plans, v, { headerKey: 'plans_list_header', footerKey: 'plan_menu_visitor_footer', vars: { days: TRIAL_DAYS } })
    : t('plan_none', v);
  await sendText(knex, phone, body, 'flow_plans');
}

async function runBuyerSearch(knex, { phone, v, data, summary }) {
  const { findMatchingListings, formatSearchReply, logDeliveries } = buyerSearch();
  const types = Array.isArray(data.types) && data.types.length ? data.types : (data.type ? String(data.type).split(/\s*\/\s*/) : []);
  // Budget is applied in the query (a max), so over-budget listings never
  // take the few result slots (23 Oct bug: ₹2.7 crore shown for ₹50 lakh).
  const budgetInr = data.budget_inr || require('../utils/visitorFlowParsers').parsePrice(data.budget_text)?.inr || null;
  const intent = {
    propertyTypes: types, propertyType: types[0] || null, area: data.locality || data.city || data.area || null, sizeText: data.size || null, budgetInr,
  };
  let listings = await findMatchingListings(knex, intent);
  if (!listings.length && intent.area && data.city && data.locality) listings = await findMatchingListings(knex, { ...intent, area: data.city });
  if (budgetInr) listings = listings.filter((l) => l.price == null || Number(l.price) <= budgetInr * buyerSearch().BUDGET_MARGIN);
  await logDeliveries(knex, listings, phone, summary);

  await sendText(knex, phone, t('buyer_searching', v, { summary }), 'flow_buyer');
  if (!listings.length) {
    await sendText(knex, phone, t('buyer_no_match', v, { summary }), 'flow_buyer');
    return;
  }
  await sendText(knex, phone, formatSearchReply(listings, intent), 'flow_buyer');
  await sendText(knex, phone, t('buyer_footer', v), 'flow_buyer');
}

async function submitDealer(knex, { phone, name, v, text, receiving, effect }) {
  const lang = v === 'en' ? 'en' : 'hi';
  const step = await signupService().advanceSignupFromAssistant(knex, {
    phone,
    text: `${effect.dealerName}, ${effect.area}`,
    fields: { name: effect.dealerName, area: effect.area },
    lang,
    script: detectScript(text),
    receiving,
    start: true,
  });
  if (step?.signup && signupService().isComplete(step.signup)) {
    await sendText(knex, phone, t('dealer_submitted', v, { name: step.signup.name, area: step.signup.address, days: TRIAL_DAYS }), 'flow_dealer');
    return;
  }
  // Could not file the request (no tenant to attach it to, or a failure): make
  // sure the team hears about it instead of leaving the dealer waiting.
  await raiseSupportRequest(knex, {
    phone, name: effect.dealerName || name, audience: 'visitor', kind: 'callback',
    summary: `Wants to join as a dealer (name: ${effect.dealerName}, area: ${effect.area}) but the request could not be filed automatically.`,
    lastMessage: text,
  });
  const { supportConfirmLine } = require('../utils/fixedReplies');
  await sendText(knex, phone, supportConfirmLine({ script: v === 'pa' ? 'gurmukhi' : v === 'hi_deva' ? 'devanagari' : 'roman', lang: v === 'en' ? 'en' : 'hi' }), 'flow_dealer');
}

async function dealerStatus(knex, { phone, v }) {
  const ctx = await loadSignupContext(knex, phone);
  if (ctx?.status === 'pending' && ctx.name && ctx.address) {
    await sendText(knex, phone, t('dealer_pending', v, { name: ctx.name, area: ctx.address }), 'flow_dealer');
  } else {
    await sendText(knex, phone, t('greet_done', v), 'flow_dealer');
  }
}

async function runEffect(knex, { phone, name, text, receiving, v, state }, item) {
  switch (item.name) {
    case 'seller_lead_sync': await syncSellerLead(knex, { phone, name, state, effect: item }); break;
    case 'plans': await sendPlanList(knex, { phone, v }); break;
    case 'assistant':
      await handleWithAssistant(knex, {
        audience: 'visitor', phone, name, text: item.text, receiving, answerOnly: true, flowRole: state.role || 'none',
      });
      break;
    case 'support_callback':
      await raiseSupportRequest(knex, { phone, name, audience: 'visitor', kind: 'callback', summary: item.summary, lastMessage: text });
      break;
    case 'buyer_search': await runBuyerSearch(knex, { phone, v, data: item.data, summary: item.summary }); break;
    case 'buyer_quick_search': {
      // A new search typed after the flow ended: answered if it really is one.
      const found = await buyerSearch().handleBuyerSearch(knex, { incomingText: item.text, buyerPhone: phone });
      if (found) await sendText(knex, phone, found.replyText, 'flow_buyer');
      break;
    }
    case 'dealer_submit': await submitDealer(knex, { phone, name, v, text, receiving, effect: item }); break;
    case 'dealer_status': await dealerStatus(knex, { phone, v }); break;
    default: console.warn('[VisitorFlow] unknown effect', item.name);
  }
}

async function runOut(knex, ctx, out) {
  for (const item of out) {
    try {
      if (item.type === 'reply') {
        await sendText(knex, ctx.phone, render(item, ctx.v));
        continue;
      }
      // Each effect runs in its own (save)point: a failed statement must not
      // poison the webhook's transaction and lose the saved state.
      await knex.transaction((tx) => runEffect(tx, ctx, item));
    } catch (err) {
      console.error('[VisitorFlow] %s failed: %s', item.name || item.key, err.message);
    }
  }
}

// ------------------------------------------------------------------- entry

/**
 * One text message from a visitor on the platform number. Returns
 * { handled: true, action } once replies are queued, or { handled: false }
 * (flow off / storage failure) so the caller can use the old behaviour.
 */
async function handleVisitorFlow(knex, { phone, name = null, text, receiving = {} }) {
  if (!isEnabled() || !text || !String(text).trim()) return { handled: false };
  const p = normalizePhone(phone) || phone;
  const body = String(text).trim();

  let state; let result;
  try {
    state = await loadState(knex, p);
    const [knownCities, pending] = await Promise.all([loadCityNames(knex), loadSignupContext(knex, p)]);
    result = decide(state, body, { knownCities, pending });
    await saveState(knex, p, result.state);
  } catch (err) {
    console.error('[VisitorFlow] state failure, falling back to the assistant:', err.message);
    return { handled: false };
  }

  await logTurn(knex, { phone: p, direction: 'inbound', body });
  await runOut(knex, { phone: p, name, text: body, receiving, v: result.v, state: result.state }, result.out);
  console.log('[VisitorFlow] %s role=%s step=%s', p, result.state.role || '-', result.state.step);
  return { handled: true, action: `flow_${result.state.role || 'role'}_${result.state.step}` };
}

/**
 * A photo from a visitor. Only used while an owner is at the photos step;
 * anything else returns { handled: false }. `deps` = { download(mediaId),
 * upload(buffer, filename, mimeType, prefix) } (WhatsApp media + S3).
 */
async function handleVisitorPhoto(knex, { phone, name = null, mediaId, mimeType, deps }) {
  if (!isEnabled()) return { handled: false };
  const p = normalizePhone(phone) || phone;
  let state;
  try { state = await loadState(knex, p); } catch { return { handled: false }; }
  if (!acceptsPhoto(state)) return { handled: false };
  const v = state.data.v || 'hi';

  let url;
  try {
    const buffer = await deps.download(mediaId);
    const ext = mimeType?.includes('png') ? 'png' : mimeType?.includes('webp') ? 'webp' : 'jpg';
    url = await deps.upload(buffer, `seller-${mediaId}.${ext}`, mimeType || 'image/jpeg', 'seller-photos');
  } catch (err) {
    console.error('[VisitorFlow] owner photo failed:', err.message);
    await sendText(knex, p, t('owner_photo_failed', v), 'flow_owner');
    return { handled: true, action: 'flow_owner_photo_failed' };
  }

  const result = afterPhoto(state, url);
  await saveState(knex, p, result.state);
  await runOut(knex, { phone: p, name, text: '[photo]', receiving: {}, v, state: result.state }, result.out);
  return { handled: true, action: 'flow_owner_photo' };
}

module.exports = {
  isEnabled,
  loadState,
  saveState,
  render,
  handleVisitorFlow,
  handleVisitorPhoto,
  ownerHintPatch,
};
