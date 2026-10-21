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

function trialReminderMessage(daysLeft) {
  const when = daysLeft <= 1 ? 'kal' : `${daysLeft} din mein`;
  return [
    `⏰ Aapka Plotraa free trial *${when}* khatam ho raha hai.`,
    'Listing chalu rakhne ke liye plan choose karke payment kar dijiye: QR se pay karein, ya cash dekar receipt ki photo bhejein ("payment" likh ke).',
    'Plans dekhne ke liye *plan* likhein.',
  ].join('\n');
}

function trialExpiredMessage() {
  return [
    '⛔ Aapka 7 din ka free trial khatam ho gaya hai.',
    'Ab nayi listing add nahi ho sakti, aur naye leads Plotraa team ke paas rahenge. Aapki purani listings live rahengi.',
    'Payment karte hi sab dobara chalu: QR se pay karein ya "payment" likh ke receipt bhejein. Plans ke liye *plan* likhein.',
  ].join('\n');
}

/**
 * Is this dealer (tenant) allowed to get new leads / add listings? False
 * when the dealer's owner account is blocked (trial over or payment overdue).
 */
async function dealerIsActive(knex, tenantId) {
  const owner = await knex('users').where({ tenant_id: tenantId, role: 'owner' })
    .orderBy('created_at', 'asc').first('can_add_listing');
  return !owner || owner.can_add_listing !== false;
}

module.exports = { trialDaysLeft, trialStep, trialReminderMessage, trialExpiredMessage, dealerIsActive, REMIND_FROM_DAYS_LEFT };
