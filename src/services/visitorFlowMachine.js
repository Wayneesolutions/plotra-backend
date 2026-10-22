// src/services/visitorFlowMachine.js
//
// The role flow for people who message the Plotraa platform number (22 Oct
// fixes). Pure decision logic: no database, no model, no WhatsApp. Given the
// saved state and the incoming text it returns the next state and an ordered
// list of things to do (replies and effects). visitorFlowService.js saves the
// state and carries the list out. Everything here is unit-tested.
//
// Rules (from the QA list):
//  - The FIRST message always gets the role menu (Buyer / Owner / Dealer);
//    the bot never guesses. A person who states their role outright
//    ("main dealer hoon", "kothi bechni hai", "join") skips the menu: that
//    is what they said, not a guess.
//  - "menu" (or "role badlo") changes the role at any time. A new explicit
//    statement ("join", "main dealer hoon") also switches, so someone tagged
//    as an owner can still become a dealer (bug E).
//  - Each role is a step-by-step flow, one question at a time:
//      owner  type -> size -> location -> price -> photos
//      buyer  budget -> area -> type -> size -> search
//      dealer name -> area -> request sent (7-day trial + payment explained)
//  - Once a flow is finished, a greeting or a question is answered as such:
//    "hi" never gets the owner confirmation again (bug A).
//  - A question in the middle of a flow ("plan kya hai?") is answered by the
//    assistant, then the same step is asked again.
//
// An `out` item is either
//   { type: 'reply', key, vars }   a fixed text from utils/i18n.js (vars may
//                                  hold nested { key, vars } replies)
//   { type: 'effect', name, ... }  something visitorFlowService must do

const {
  explicitRole, parseRoleChoice, isMenuCommand, isSkip, isDone, isGreeting, isPlanListRequest,
  mentionsYearly, looksLikeQuestion, parsePropertyType, parseSize, parsePrice, splitLocation, looksLikeName,
} = require('../utils/visitorFlowParsers');
const { variantFor } = require('../utils/i18n');
const { detectScript, detectMessageLanguage } = require('../utils/replyLanguage');

const FLOWS = {
  owner: ['type', 'size', 'location', 'price', 'photos'],
  buyer: ['budget', 'area', 'type', 'size'],
  dealer: ['name', 'area'],
};
const MAX_PHOTOS = 5;
const TRIAL_DAYS = Number(process.env.DEALER_TRIAL_DAYS) || 7;

const reply = (key, vars = {}) => ({ type: 'reply', key, vars });
const effect = (name, extra = {}) => ({ type: 'effect', name, ...extra });

function blankState() {
  return { role: null, step: 'role', data: { done: {} } };
}

/** The question for one step, as a reply item. */
function promptFor(role, step, data = {}) {
  if (role === 'dealer' && step === 'name') return reply('dealer_ask_name', { days: TRIAL_DAYS });
  if (role === 'dealer' && step === 'area') return reply('dealer_ask_area', { name: String(data.name || '').split(/\s+/)[0] || '' });
  if (step === 'role') return reply('role_menu');
  return reply(`${role}_ask_${step}`);
}

function firstOpenStep(role, data) {
  return FLOWS[role].find((s) => !data.done?.[s]) || null;
}

/** Variant for this message: its own script/language, else the last one seen, else Hinglish. */
function pickVariant(text, state) {
  const t = String(text || '');
  if (detectScript(t) !== 'roman' || detectMessageLanguage(t)) return variantFor(t);
  return state?.data?.v || 'hi';
}

const isMenuNumber = (text) => /^\s*[1-5][\s.)]*$/.test(String(text || ''));

/**
 * What the first message already told us (type, size, price), so the flow
 * does not ask it again. The menu digit of the role menu is not an answer.
 */
function prefillFrom(role, text) {
  const data = { done: {} };
  const t = String(text || '');
  if (!t.trim() || isMenuNumber(t)) return data;
  if (role === 'owner' || role === 'buyer') {
    const type = parsePropertyType(t, { allowMenuNumber: false });
    if (type) { data.type = type; data.done.type = true; }
    const size = parseSize(t);
    if (size) { data.size = size; data.done.size = true; }
    const price = parsePrice(t);
    if (price) {
      if (role === 'owner') { data.price_text = price.text; data.price_inr = price.inr; data.done.price = true; }
      else { data.budget_text = price.text; data.budget_inr = price.inr; data.done.budget = true; }
    }
  }
  return data;
}

function ownerSummary(data) {
  const loc = [data.locality, data.city].filter(Boolean).join(', ');
  return [
    data.type && `🏠 ${data.type}`,
    data.size && `📐 ${data.size}`,
    loc && `📍 ${loc}`,
    data.price_text && `💰 ${data.price_text}`,
    data.photo_urls?.length && `📷 ${data.photo_urls.length}`,
  ].filter(Boolean).join('\n') || '-';
}

function buyerSummary(data) {
  const loc = [data.locality, data.city].filter(Boolean).join(', ') || data.area;
  return [
    data.type, data.size, loc && `in ${loc}`, data.budget_text && `budget ${data.budget_text}`,
  ].filter(Boolean).join(' ') || 'property';
}

/** Starting (or restarting) a role: its intro line + the first open question. */
function startRole(role, { text = '', pending = null, prevData = {} } = {}) {
  const data = prefillFrom(role, text);
  data.v = prevData.v;
  if (role === 'dealer') {
    if (pending?.status === 'pending' && pending.name && pending.address) {
      return {
        state: { role, step: 'done', data: { ...data, name: pending.name, area: pending.address } },
        out: [reply('role_set_dealer'), reply('dealer_pending', { name: pending.name, area: pending.address })],
      };
    }
    if (pending?.status === 'rejected') {
      return {
        state: { role, step: 'done', data },
        out: [effect('support_callback', { summary: 'An earlier request to join as a dealer was not approved; they want to join again.' }), reply('dealer_rejected')],
      };
    }
    if (pending?.status === 'pending' && pending.name) { data.name = pending.name; data.done.name = true; }
  }
  const step = firstOpenStep(role, data);
  const state = { role, step, data };
  // One message: the intro line and the first question together.
  const out = [{ ...reply(`role_set_${role}`), then: promptFor(role, step, data) }];
  if (role === 'owner') out.push(effect('seller_lead_sync', { fresh: true, data }));
  return { state, out };
}

// ---------------------------------------------------------------- step answers

/**
 * Reads the answer to the current step. Returns { ok, patch } where patch is
 * merged into data (and data.done[step] set), or { ok: false }.
 */
function readAnswer(role, step, text, data, knownCities) {
  const t = String(text || '').trim();
  const skip = isSkip(t);
  const rawNumber = /^\s*\d[\d.,\s]*\s*$/.test(t) ? t : null;

  if (role === 'owner') {
    if (step === 'type') {
      const type = parsePropertyType(t);
      return type ? { ok: true, patch: { type } } : { ok: false };
    }
    if (step === 'size') {
      if (skip) return { ok: true, patch: {} };
      const size = parseSize(t);
      if (size) return { ok: true, patch: { size } };
      return rawNumber ? { ok: true, patch: { size: t.slice(0, 40) } } : { ok: false };
    }
    if (step === 'location') {
      if (skip || t.length < 2 || looksLikeQuestion(t) || /^\s*\d+\s*$/.test(t)) return { ok: false };
      return { ok: true, patch: splitLocation(t, knownCities) };
    }
    if (step === 'price') {
      if (skip) return { ok: true, patch: {} };
      const price = parsePrice(t);
      if (price) return { ok: true, patch: { price_text: price.text, price_inr: price.inr } };
      return rawNumber ? { ok: true, patch: { price_text: t.slice(0, 40) } } : { ok: false };
    }
  }

  if (role === 'buyer') {
    if (step === 'budget') {
      if (skip) return { ok: true, patch: {} };
      const price = parsePrice(t);
      if (price) return { ok: true, patch: { budget_text: price.text, budget_inr: price.inr } };
      return rawNumber ? { ok: true, patch: { budget_text: t.slice(0, 40) } } : { ok: false };
    }
    if (step === 'area') {
      if (skip) return { ok: true, patch: {} };
      if (t.length < 2 || looksLikeQuestion(t) || /^\s*\d+\s*$/.test(t)) return { ok: false };
      const loc = splitLocation(t, knownCities);
      return { ok: true, patch: { area: t.slice(0, 120), locality: loc.locality, city: loc.city } };
    }
    if (step === 'type') {
      if (skip) return { ok: true, patch: {} };
      const type = parsePropertyType(t);
      return type ? { ok: true, patch: { type } } : { ok: false };
    }
    if (step === 'size') {
      if (skip) return { ok: true, patch: {} };
      const size = parseSize(t);
      if (size) return { ok: true, patch: { size } };
      return rawNumber ? { ok: true, patch: { size: t.slice(0, 40) } } : { ok: false };
    }
  }

  if (role === 'dealer') {
    if (step === 'name') return looksLikeName(t) ? { ok: true, patch: { name: t.replace(/\s+/g, ' ') } } : { ok: false };
    if (step === 'area') {
      if (t.length < 2 || looksLikeQuestion(t) || isMenuCommand(t)) return { ok: false };
      return { ok: true, patch: { area: t.replace(/\s+/g, ' ').slice(0, 200) } };
    }
  }
  return { ok: false };
}

/** After a step is answered: the next question, or the flow's ending. */
function afterAnswer(role, data) {
  const step = firstOpenStep(role, data);
  const out = [];
  if (step) return { step, out: [promptFor(role, step, data)] };

  if (role === 'owner') {
    out.push(effect('seller_lead_sync', { data, final: true }));
    out.push(reply('owner_done', { summary: ownerSummary(data) }));
  } else if (role === 'buyer') {
    out.push(effect('buyer_search', { data, summary: buyerSummary(data) }));
  } else if (role === 'dealer') {
    out.push(effect('dealer_submit', { dealerName: data.name, area: data.area }));
  }
  return { step: 'done', out };
}

// ------------------------------------------------------------------- decide

/**
 * One incoming TEXT message. `state` = saved { role, step, data } or null.
 * ctx: { knownCities: string[], pending: {status,name,address}|null }.
 * Returns { state, out, v }.
 */
function decide(state, text, ctx = {}) {
  const t = String(text || '').trim();
  const knownCities = ctx.knownCities || [];
  const v = pickVariant(t, state);
  const withV = (s) => ({ ...s, data: { ...s.data, v } });
  const finish = (s, out) => ({ state: withV(s), out, v });

  // ---- no state yet: first message ever
  if (!state) {
    const role = explicitRole(t);
    if (role) {
      const started = startRole(role, { text: t, pending: ctx.pending });
      return finish(started.state, started.out);
    }
    if (isPlanListRequest(t)) {
      const s = { ...blankState(), data: { done: {}, first_text: t } };
      return finish(s, [effect('plans'), reply('role_menu')]);
    }
    const s = { ...blankState(), data: { done: {}, first_text: t } };
    return finish(s, [reply('role_menu')]);
  }

  // ---- "menu": change role any time
  if (isMenuCommand(t)) {
    return finish({ role: null, step: 'role', data: { done: {}, first_text: '', v } }, [reply('role_menu')]);
  }

  // ---- restart words after a finished flow ("sell", "search")
  const stated = explicitRole(t);
  if (stated && (stated !== state.role || /^\s*(?:sell|search|buy)\s*[.!?]*\s*$/i.test(t))) {
    const started = startRole(stated, { text: t, pending: ctx.pending, prevData: { v } });
    return finish(started.state, started.out);
  }

  // ---- the person repeats the role they are already in ("main dealer hoon" while
  // giving their name): not an answer to the step. Use any details in it, then
  // ask the next open question.
  if (stated && stated === state.role && state.step !== 'done' && state.step !== 'role') {
    const data = { ...state.data, done: { ...(state.data.done || {}) } };
    const hints = prefillFrom(state.role, t);
    for (const [k, val] of Object.entries(hints)) {
      if (k === 'done' || k === 'v') continue;
      const stepOfKey = { price_text: 'price', price_inr: 'price', budget_text: 'budget', budget_inr: 'budget' }[k] || k;
      if (!data.done[stepOfKey]) data[k] = val;
    }
    for (const k of Object.keys(hints.done)) if (!data.done[k]) data.done[k] = true;
    const open = firstOpenStep(state.role, data);
    if (!open) {
      const after = afterAnswer(state.role, data);
      return finish({ role: state.role, step: after.step, data }, [...(state.role === 'owner' ? [effect('seller_lead_sync', { data })] : []), ...after.out]);
    }
    return finish({ role: state.role, step: open, data }, [...(state.role === 'owner' ? [effect('seller_lead_sync', { data })] : []), reply('question_then_step', { prompt: promptFor(state.role, open, data) })]);
  }

  // ---- waiting for the role menu answer
  if (!state.role || state.step === 'role') {
    const choice = parseRoleChoice(t);
    if (choice) {
      const started = startRole(choice, { text: state.data?.first_text, pending: ctx.pending, prevData: { v } });
      return finish(started.state, started.out);
    }
    if (isPlanListRequest(t)) return finish(state, [effect('plans'), reply('role_retry')]);
    if (mentionsYearly(t)) return finish(state, [reply('yearly_unknown', { support: '__support__' }), reply('role_retry')]);
    if (looksLikeQuestion(t)) return finish(state, [effect('assistant', { text: t }), reply('role_retry')]);
    if (isGreeting(t)) return finish(state, [reply('role_menu')]);
    return finish(state, [reply('role_retry')]);
  }

  const { role } = state;
  const data = { ...state.data, done: { ...(state.data.done || {}) } };

  // ---- a finished flow: greetings and questions are answered as what they are
  if (state.step === 'done') {
    if (isPlanListRequest(t)) return finish(state, [effect('plans')]);
    if (mentionsYearly(t)) return finish(state, [reply('yearly_unknown', { support: '__support__' })]);
    if (role === 'buyer' && /^\s*call\s*[.!?]*\s*$/i.test(t)) {
      return finish(state, [effect('support_callback', { summary: `Buyer wants a call: ${buyerSummary(data)}` }), reply('buyer_call_ok')]);
    }
    if (isGreeting(t)) {
      if (role === 'dealer') return finish(state, [effect('dealer_status')]);
      return finish(state, [reply(role === 'owner' ? 'owner_after_done' : 'greet_done')]);
    }
    if (looksLikeQuestion(t)) return finish(state, [effect('assistant', { text: t })]);
    if (role === 'owner') return finish(state, [effect('seller_lead_sync', { data: { ...data, ...ownerHintPatch(t) }, hintsOnly: true }), reply('owner_after_done')]);
    if (role === 'buyer') return finish(state, [effect('buyer_quick_search', { text: t }), reply('buyer_footer')]);
    return finish(state, [effect('dealer_status')]);
  }

  // ---- inside a flow
  const step = state.step;
  if (isGreeting(t)) {
    return finish(state, [reply('question_then_step', { prompt: promptFor(role, step, data) })]);
  }
  if (isPlanListRequest(t)) {
    return finish(state, [effect('plans'), reply('question_then_step', { prompt: promptFor(role, step, data) })]);
  }
  if (mentionsYearly(t)) {
    return finish(state, [reply('yearly_unknown', { support: '__support__' }), reply('question_then_step', { prompt: promptFor(role, step, data) })]);
  }

  if (role === 'owner' && step === 'photos') {
    if (isDone(t) || isSkip(t)) {
      data.done.photos = true;
      const after = afterAnswer(role, data);
      return finish({ role, step: after.step, data }, after.out);
    }
    if (looksLikeQuestion(t)) {
      return finish(state, [effect('assistant', { text: t }), reply('question_then_step', { prompt: promptFor(role, step, data) })]);
    }
    return finish(state, [reply('owner_ask_photos')]);
  }

  const answer = readAnswer(role, step, t, data, knownCities);
  if (answer.ok) {
    Object.assign(data, answer.patch);
    data.done[step] = true;
    const after = afterAnswer(role, data);
    const out = [];
    if (role === 'owner') out.push(effect('seller_lead_sync', { data }));
    out.push(...after.out);
    return finish({ role, step: after.step, data }, out);
  }

  // not an answer: a question gets answered, then the same question again
  if (looksLikeQuestion(t)) {
    return finish(state, [effect('assistant', { text: t }), reply('question_then_step', { prompt: promptFor(role, step, data) })]);
  }
  data.retries = { ...(data.retries || {}) };
  if ((data.retries[step] || 0) < 1) {
    data.retries[step] = (data.retries[step] || 0) + 1;
    return finish({ role, step, data }, [reply('step_retry', { prompt: promptFor(role, step, data) })]);
  }
  // second miss: stop asking the same thing; keep what they wrote when it is free text
  const lenient = leniently(role, step, t, knownCities);
  Object.assign(data, lenient);
  data.done[step] = true;
  const after = afterAnswer(role, data);
  const out = [];
  if (role === 'owner') out.push(effect('seller_lead_sync', { data }));
  out.push(...after.out);
  return finish({ role, step: after.step, data }, out);
}

/** After two misses: keep the raw text for free-text steps, skip the rest. */
function leniently(role, step, text, knownCities) {
  const t = String(text || '').trim().slice(0, 120);
  if (role === 'owner' && step === 'size') return { size: t };
  if (role === 'owner' && step === 'price') return { price_text: t };
  if (role === 'owner' && step === 'location') return splitLocation(t, knownCities);
  if (role === 'buyer' && step === 'area') return { area: t, ...splitLocation(t, knownCities) };
  if (role === 'buyer' && step === 'budget') return { budget_text: t };
  if (role === 'buyer' && step === 'size') return { size: t };
  if (role === 'dealer' && step === 'name') return { name: t };
  if (role === 'dealer' && step === 'area') return { area: t };
  return {};
}

/** Extra details an owner mentions after finishing (fills blanks on their lead only). */
function ownerHintPatch(text) {
  const patch = {};
  const type = parsePropertyType(text, { allowMenuNumber: false });
  if (type) patch.type = type;
  const size = parseSize(text);
  if (size) patch.size = size;
  const price = parsePrice(text);
  if (price) { patch.price_text = price.text; patch.price_inr = price.inr; }
  return patch;
}

/** A photo arrived. Only meaningful for an owner at the photos step. */
function acceptsPhoto(state) {
  return Boolean(state && state.role === 'owner' && state.step === 'photos');
}

/** State after one more photo was saved: finish when the limit is reached. */
function afterPhoto(state, url) {
  const data = { ...state.data, done: { ...(state.data.done || {}) }, photo_urls: [...(state.data.photo_urls || []), url] };
  if (data.photo_urls.length >= MAX_PHOTOS) {
    data.done.photos = true;
    return {
      state: { role: 'owner', step: 'done', data },
      out: [effect('seller_lead_sync', { data, final: true }), reply('owner_photo_limit'), reply('owner_done', { summary: ownerSummary(data) })],
    };
  }
  return {
    state: { role: 'owner', step: 'photos', data },
    out: [effect('seller_lead_sync', { data }), reply('owner_photo_saved', { n: data.photo_urls.length })],
  };
}

module.exports = {
  FLOWS,
  MAX_PHOTOS,
  TRIAL_DAYS,
  blankState,
  decide,
  startRole,
  promptFor,
  firstOpenStep,
  prefillFrom,
  ownerSummary,
  buyerSummary,
  acceptsPhoto,
  afterPhoto,
  ownerHintPatch,
};
