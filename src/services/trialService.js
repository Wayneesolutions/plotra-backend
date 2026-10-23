// src/services/trialService.js
//
// New dealers' free trial (21 Oct 2026 decision): 7 days from approval.
// Reminders start after day 5 (2 days left, then 1 day left). When the trial
// ends without an approved payment, the dealer (and their sub-dealers) can't
// add NEW listings; existing listings stay live, and the super admin keeps
// their leads (seller-lead forwarding skips them) until they pay.
//
// Pure decision logic here (unit-tested); paymentReminderWorker.js runs it
// daily and does the writes/sends.

const DAY_MS = 24 * 60 * 60 * 1000;
const REMIND_FROM_DAYS_LEFT = Number(process.env.TRIAL_REMIND_DAYS_LEFT) || 2; // day 5 of 7

/** Whole days left in the trial, rounded up (0 = ends today or already over). */
function trialDaysLeft(trialEndsAt, now = new Date()) {
  return Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - now.getTime()) / DAY_MS));
}

/**
 * What to do today for one user.
 *   user: { trial_ends_at, can_add_listing, trial_reminder_day }
 *   hasApprovedPayment: true once any payment of theirs was approved
 * Returns { type: 'none' | 'remind' | 'expire', daysLeft }.
 * A paying dealer is out of the trial logic (the monthly cycle takes over).
 */
function trialStep(user, { hasApprovedPayment = false, now = new Date() } = {}) {
  if (!user || !user.trial_ends_at || hasApprovedPayment) return { type: 'none', daysLeft: null };
  const ended = now.getTime() >= new Date(user.trial_ends_at).getTime();
  if (ended) return { type: user.can_add_listing ? 'expire' : 'none', daysLeft: 0 };
  const daysLeft = trialDaysLeft(user.trial_ends_at, now);
  if (daysLeft <= REMIND_FROM_DAYS_LEFT && user.trial_reminder_day !== daysLeft) {
    return { type: 'remind', daysLeft };
  }
  return { type: 'none', daysLeft };
}

/**
 * Billing state of a dealer, for the dashboard banner, the admin list and the
 * chat. `user` = { trial_ends_at, can_add_listing, payment_status }.
 *   trial    free trial running (days_left >= 0)
 *   paid     an approved payment exists and new listings are allowed
 *   expired  trial over without payment, or a paid dealer's month is overdue
 *   none     not on a trial and nothing to show (older agents, sub-dealers)
 */
function billingState(user, { hasApprovedPayment = false, now = new Date() } = {}) {
  const trialEndsAt = user?.trial_ends_at ? new Date(user.trial_ends_at) : null;
  const base = { trial_ends_at: trialEndsAt ? trialEndsAt.toISOString() : null, can_add_listing: user?.can_add_listing !== false };
  if (hasApprovedPayment) {
    return { ...base, status: base.can_add_listing ? 'paid' : 'expired', days_left: null, reason: base.can_add_listing ? null : 'payment_overdue' };
  }
  if (trialEndsAt) {
    if (now.getTime() < trialEndsAt.getTime()) return { ...base, status: 'trial', days_left: trialDaysLeft(trialEndsAt, now), reason: null };
    return { ...base, status: 'expired', days_left: 0, reason: 'trial_ended' };
  }
  return { ...base, status: 'none', days_left: null, reason: null };
}

/** India-time "28 Oct" for messages. */
function shortDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/**
 * Trial reminder text. `payLine` is the ready-made "💳 Pay here: link" line
 * (or the "type plan" hint when there is no link yet).
 */
function trialReminderMessage(daysLeft, { v = 'hi', trialEndsAt = null, payLine = '' } = {}) {
  const { t } = require('../utils/i18n');
  const when = daysLeft <= 1 ? t('trial_when_tomorrow', v) : t('trial_days_left', v, { n: daysLeft });
  return t('trial_reminder', v, { when, date: trialEndsAt ? shortDate(trialEndsAt) : '', pay: payLine })
    .replace(/\s*\(\s*\)/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function trialExpiredMessage({ v = 'hi', trialEndsAt = null, payLine = '' } = {}) {
  const { t } = require('../utils/i18n');
  return t('trial_expired', v, { date: trialEndsAt ? shortDate(trialEndsAt) : '', pay: payLine })
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Is this dealer (tenant) allowed to get new leads / add listings? False
 * when the dealer's owner account is blocked (payment overdue) OR the free
 * trial date has passed without a payment. The date is checked here too, not
 * only the can_add_listing flag, because the hourly/daily job that flips the
 * flag can lag behind trial_ends_at (23 Oct bug: listings were still being
 * created for up to an hour after the trial ended).
 */
async function dealerIsActive(knex, tenantId, now = new Date()) {
  const billing = await dealerBilling(knex, tenantId, now);
  if (!billing) return true;
  return billing.can_add_listing !== false && billing.status !== 'expired';
}

/**
 * Pure: may this user start / publish a NEW listing right now? Uses the flag
 * and the trial date together, so an ended trial blocks immediately even if
 * the cron has not run yet.
 */
function listingAllowed(user, { hasApprovedPayment = false, now = new Date() } = {}) {
  if (!user || user.can_add_listing === false) return false;
  return billingState(user, { hasApprovedPayment, now }).status !== 'expired';
}

/**
 * May this user (dealer or sub-dealer) add / publish a NEW listing right now?
 * Checks their own row (flag + trial date) and their dealer's (sub-dealers
 * share the dealer's trial / payment state).
 */
async function canAddNewListing(knex, user, now = new Date()) {
  if (!user || user.can_add_listing === false) return false;
  if (user.trial_ends_at) {
    const paid = await knex('payment_submissions').where({ agent_id: user.id, status: 'approved' }).first('id');
    if (!listingAllowed(user, { hasApprovedPayment: Boolean(paid), now })) return false;
  }
  if (user.tenant_id) return dealerIsActive(knex, user.tenant_id, now);
  return true;
}

/**
 * Billing state of the dealer that owns `tenantId` (sub-dealers share their
 * dealer's state). Returns { ...billingState, user } or null.
 */
async function dealerBilling(knex, tenantId, now = new Date()) {
  const owner = await knex('users').where({ tenant_id: tenantId, role: 'owner' })
    .orderBy('created_at', 'asc').first('id', 'name', 'phone', 'tenant_id', 'trial_ends_at', 'can_add_listing', 'payment_status', 'selected_plan_key');
  if (!owner) return null;
  const paid = await knex('payment_submissions').where({ agent_id: owner.id, status: 'approved' }).first('id');
  return { ...billingState(owner, { hasApprovedPayment: Boolean(paid), now }), user: owner };
}

module.exports = {
  trialDaysLeft, trialStep, billingState, dealerBilling, shortDate,
  trialReminderMessage, trialExpiredMessage, dealerIsActive, listingAllowed, canAddNewListing, REMIND_FROM_DAYS_LEFT,
};
