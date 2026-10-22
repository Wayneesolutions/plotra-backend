const test = require('node:test');
const assert = require('node:assert');
const { trialStep, trialDaysLeft, trialReminderMessage, trialExpiredMessage } = require('../src/services/trialService');
const {
  buildDealerWelcomeMessage, buildSubDealerWelcomeMessage, placeholderEmail, isPlaceholderEmail, trialEndsAt,
} = require('../src/services/dealerOnboardingService');

const DAY = 24 * 60 * 60 * 1000;
const approved = new Date('2026-10-21T15:00:00+05:30');
const user = (over = {}) => ({ trial_ends_at: trialEndsAt(approved), can_add_listing: true, trial_reminder_day: null, ...over });
const at = (days) => new Date(approved.getTime() + days * DAY);

test('trial is 7 days', () => {
  assert.strictEqual(trialEndsAt(approved).getTime() - approved.getTime(), 7 * DAY);
});

test('no reminder in the first 5 days', () => {
  for (const d of [0, 1, 3, 4.9]) assert.strictEqual(trialStep(user(), { now: at(d) }).type, 'none', `day ${d}`);
});

test('reminders after day 5: 2 days left, then 1 day left, each once', () => {
  assert.deepStrictEqual(trialStep(user(), { now: at(5.2) }), { type: 'remind', daysLeft: 2 });
  assert.strictEqual(trialStep(user({ trial_reminder_day: 2 }), { now: at(5.5) }).type, 'none', 'not twice');
  assert.deepStrictEqual(trialStep(user({ trial_reminder_day: 2 }), { now: at(6.1) }), { type: 'remind', daysLeft: 1 });
  assert.strictEqual(trialStep(user({ trial_reminder_day: 1 }), { now: at(6.9) }).type, 'none');
});

test('trial over: listings stop once; paying dealers are out of the trial logic', () => {
  assert.strictEqual(trialStep(user(), { now: at(7) }).type, 'expire');
  assert.strictEqual(trialStep(user({ can_add_listing: false }), { now: at(9) }).type, 'none', 'already stopped');
  assert.strictEqual(trialStep(user(), { now: at(8), hasApprovedPayment: true }).type, 'none');
  assert.strictEqual(trialStep({ trial_ends_at: null, can_add_listing: true }, { now: at(30) }).type, 'none', 'not a trial user');
  assert.strictEqual(trialDaysLeft(trialEndsAt(approved), at(7.5)), 0);
});

test('trial messages say what stops and what stays', () => {
  assert.match(trialReminderMessage(1), /kal/);
  assert.match(trialReminderMessage(2), /2 din/);
  const end = trialExpiredMessage();
  assert.match(end, /nayi listing add nahi/i);
  assert.match(end, /purani listings live/);
  assert.match(end, /leads Plotraa team/);
});

test('dealer welcome has the set-password link and phone login, never a password', () => {
  const msg = buildDealerWelcomeMessage({ name: 'Rajesh', lang: 'hi', phone: '+919876543210', setupUrl: 'https://plotraa.com/reset-password?token=abc&setup=1', trialEnd: trialEndsAt(approved) });
  assert.match(msg, /dealer account approve/);
  assert.match(msg, /7 din ka free trial/);
  assert.match(msg, /Login ID: \+919876543210/);
  assert.match(msg, /reset-password\?token=abc&setup=1/);
  assert.doesNotMatch(msg, /Welcome[0-9a-f]{8}!|🔑 Password:|password: /i);
  const en = buildDealerWelcomeMessage({ name: 'Simran', lang: 'en', phone: '+91', setupUrl: 'u', trialEnd: trialEndsAt(approved) });
  assert.match(en, /7-day free trial/);
  assert.match(buildSubDealerWelcomeMessage({ name: 'Aman', dealerName: 'Sharma Properties', phone: '+91', setupUrl: 'LINK' }), /Sharma Properties.*sub-dealer[\s\S]*LINK/);
});

test('placeholder emails are recognisable', () => {
  assert.strictEqual(placeholderEmail('+91 98765 43210'), 'dealer.919876543210@wa-signup.plotra.internal');
  assert.ok(isPlaceholderEmail(placeholderEmail('+919876543210', 'subdealer')));
  assert.ok(!isPlaceholderEmail('raj@gmail.com'));
});
