const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const T = require('../src/services/whatsappTemplates');
const rz = require('../src/services/razorpayService');
const logs = require('../src/services/whatsappLogService');
const { formatPackageMenu, buildPlanMenuMessage, parsePlanChoice } = require('../src/services/agentPaymentService');
const trial = require('../src/services/trialService');
const { bannerText } = require('../src/controllers/dealerBillingController');
const { planTrialRepair } = require('../src/services/dealerOnboardingService');
const { quickAgentIntent } = require('../src/utils/agentQuickIntent');
const { looksLikeSaleDetails } = require('../src/utils/sellerIntent');
const { supportAlertParams } = require('../src/services/supportRequestService');
const { buildTemplateJob } = require('../src/services/callEnquiryService');

// ---------------------------------------------------------------- templates

test('every Plotraa template builds with exactly its declared number of variables', () => {
  const values = { name: 'Raj', trial_end_date: '28 Oct', login_id: '+919876543210', set_password_link: 'https://plotraa.com/reset-password?token=x&setup=1', dealer_name: 'Sharma', reset_link: 'https://x', valid_minutes: 30, time_left: '2 days', pay_link_or_hint: 'https://rzp.io/i/x', plan_label: 'Basic', lead_name: 'Owner', lead_phone: '+91', lead_details: 'Plot in Dugri' };
  for (const [key, def] of Object.entries(T.PLOTRAA_TEMPLATES)) {
    const tpl = T.buildTemplate(key, values);
    assert.strictEqual(tpl.bodyParams.length, def.params.length, key);
    assert.strictEqual(tpl.expectedParams, def.params.length, key);
    assert.strictEqual(tpl.templateMode, 'auto');
    // the text submitted to Meta uses exactly {{1}}..{{n}}
    const used = [...def.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual([...new Set(used)].sort(), Array.from({ length: def.params.length }, (_, i) => i + 1), `${key} body placeholders`);
    tpl.bodyParams.forEach((p) => { assert.ok(p.length > 0); assert.doesNotMatch(p, /[\n\t]| {2,}/); });
  }
});

test('template variables are cleaned the way Meta requires (no newline, tab, empty)', () => {
  assert.strictEqual(T.sanitizeParam('a\nb\tc   d'), 'a b c d');
  assert.strictEqual(T.sanitizeParam('', 'x'), 'x');
  assert.strictEqual(T.sanitizeParam(null), '-');
  assert.throws(() => T.assertParamCount('dealer_welcome', ['only one']));
  assert.throws(() => T.buildTemplate('nope'));
});

test('template name and language can be set from the environment', () => {
  process.env.WA_TPL_DEALER_WELCOME = 'my_welcome_v2';
  process.env.WA_TPL_DEALER_WELCOME_LANG = 'hi';
  const tpl = T.buildTemplate('dealer_welcome', { name: 'a', trial_end_date: 'b', login_id: 'c', set_password_link: 'd' });
  assert.strictEqual(tpl.name, 'my_welcome_v2');
  assert.strictEqual(tpl.lang, 'hi');
  delete process.env.WA_TPL_DEALER_WELCOME; delete process.env.WA_TPL_DEALER_WELCOME_LANG;
  assert.strictEqual(T.templateName('dealer_welcome'), 'plotraa_dealer_welcome');
});

test('the 3 existing templates: variable counts read from the code that fills them', () => {
  // support alert: {{1}} who, {{2}} phone, {{3}} what
  const params = supportAlertParams({ audience: 'agent', name: 'Raj', phone: '+91', summary: 's', kind: 'problem' }, 'Biz');
  assert.strictEqual(params.length, T.EXISTING_TEMPLATES.support_alert.bodyParams);
  assert.strictEqual(params.length, 3);
  // call enquiry: 3 body variables + 1 quick-reply button
  process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME = 'call_enquiry_listings';
  const job = buildTemplateJob({ enquiryId: 'e1', phone: '+91', buyerName: 'B', matchCount: 2, requirement: 'Plot' });
  delete process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME;
  assert.strictEqual(job.template.bodyParams.length, T.EXISTING_TEMPLATES.call_enquiry.bodyParams);
  assert.strictEqual(job.template.bodyParams.length, 3);
  assert.ok(job.template.quickReplyPayload);
  assert.strictEqual(T.EXISTING_TEMPLATES.call_enquiry.buttons, 1);
  assert.strictEqual(T.EXISTING_TEMPLATES.reengagement.bodyParams, 1); // whatsappOutboundWorker.js sends one {{1}}
});

// ----------------------------------------------------------- send log

test('24h window and Meta message ids', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  assert.strictEqual(logs.windowOpenAt(new Date('2026-10-22T08:00:00Z'), now), true);
  assert.strictEqual(logs.windowOpenAt(new Date('2026-10-21T09:00:00Z'), now), false);
  assert.strictEqual(logs.windowOpenAt(null, now), false);
  assert.strictEqual(logs.extractMessageId({ messages: [{ id: 'wamid.X' }] }), 'wamid.X');
  assert.strictEqual(logs.extractMessageId({ message_id: 'abc' }), 'abc');
  assert.strictEqual(logs.extractMessageId(null), null);
  assert.strictEqual(logs.storedPhone('919876543210'), '+919876543210');
  assert.match(logs.statusError({ errors: [{ code: 131049, title: 'Undeliverable', message: 'm' }] }), /#131049 - Undeliverable - m/);
});

// ----------------------------------------------------------- razorpay

test('razorpay webhook: signature on the raw body, and only Plotraa events (the account is shared with Waynur)', () => {
  const secret = 'whsec';
  const body = Buffer.from('{"event":"payment_link.paid"}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.strictEqual(rz.verifyWebhookSignature(body, sig, secret), true);
  assert.strictEqual(rz.verifyWebhookSignature(body, `${sig}00`, secret), false);
  assert.strictEqual(rz.verifyWebhookSignature(Buffer.from('{"event":"x"}'), sig, secret), false);
  assert.strictEqual(rz.verifyWebhookSignature(body, sig, ''), false, 'no secret configured: never trusted');
  assert.strictEqual(rz.verifyWebhookSignature(body, undefined, secret), false);

  const plotraa = rz.parseWebhookEvent({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', amount_paid: 500000, notes: { product: 'plotraa', plan_key: 'basic' } } }, payment: { entity: { id: 'pay_1', amount: 500000 } } } });
  assert.strictEqual(plotraa.linkId, 'plink_1');
  assert.strictEqual(plotraa.paymentId, 'pay_1');
  assert.strictEqual(plotraa.amountPaise, 500000);
  assert.strictEqual(rz.isPlotraaNotes(plotraa.notes), true);
  const waynur = rz.parseWebhookEvent({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_2', notes: { product: 'waynur' } } } } });
  assert.strictEqual(rz.isPlotraaNotes(waynur.notes), false);
  assert.strictEqual(rz.isPlotraaNotes(rz.parseWebhookEvent({ event: 'payment.captured', payload: { payment: { entity: { id: 'p', notes: [] } } } }).notes), false);
  assert.strictEqual(rz.isPlotraaNotes(null), false);
});

// ----------------------------------------------------------- live plans (bug B)

const PLANS = [
  { key: 'basic', label: 'Basic', price_inr: 5000, discount_percent: 40, max_users: 1, included_leads: null },
  { key: 'multi_user_leads', label: 'Multi User with Leads', price_inr: 14999, discount_percent: 30, max_users: 4, included_leads: 50 },
];

test('bug B: the plan menu is built from the live plans, never the old Lite/Growth/Unlimited', () => {
  const menu = formatPackageMenu(PLANS);
  assert.match(menu, /1\. \*Basic\* — ₹5,000\/month \(40% off\) · 1 user/);
  assert.match(menu, /2\. \*Multi User with Leads\* — ₹14,999\/month \(30% off\) · 4 users · 50 leads/);
  assert.doesNotMatch(menu, /Lite|Growth|Unlimited|3,?000|20,?000/);
  const msg = buildPlanMenuMessage(PLANS, 'pa');
  assert.match(msg, /[਀-੿]/);
  assert.match(msg, /Basic/);
});

test('plan choice: a bare number only before a plan is chosen; "plan 2" any time', () => {
  assert.strictEqual(parsePlanChoice('2', { alreadyChosen: false }), 2);
  assert.strictEqual(parsePlanChoice('2', { alreadyChosen: true }), null, 'a bare number then is listing text');
  assert.strictEqual(parsePlanChoice('plan 2', { alreadyChosen: true }), 2);
  assert.strictEqual(parsePlanChoice('Plan no. 3', { alreadyChosen: false }), 3);
  assert.strictEqual(parsePlanChoice('plot 200 gaj', { alreadyChosen: false }), null);
});

test('"plan" / "trial kab tak" are answered by the system from live data', () => {
  for (const q of ['plan', 'Plans?', 'mera plan', 'trial kab tak hai', 'trial kitne din baaki']) assert.strictEqual(quickAgentIntent(q), 'plan_info', q);
  assert.strictEqual(quickAgentIntent('discount?'), 'question');
  assert.strictEqual(quickAgentIntent('200 gaj plan'), null);
});

// ----------------------------------------------------------- trial visibility

const DAY = 24 * 60 * 60 * 1000;
test('billing state: trial / paid / expired for the banner and the admin list', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  const inDays = (d) => new Date(now.getTime() + d * DAY);
  assert.deepStrictEqual(
    (({ status, days_left }) => ({ status, days_left }))(trial.billingState({ trial_ends_at: inDays(3), can_add_listing: true }, { now })),
    { status: 'trial', days_left: 3 });
  assert.strictEqual(trial.billingState({ trial_ends_at: inDays(-1), can_add_listing: false }, { now }).status, 'expired');
  assert.strictEqual(trial.billingState({ trial_ends_at: inDays(-1), can_add_listing: false }, { now }).reason, 'trial_ended');
  assert.strictEqual(trial.billingState({ trial_ends_at: inDays(-9), can_add_listing: true }, { now, hasApprovedPayment: true }).status, 'paid');
  assert.strictEqual(trial.billingState({ trial_ends_at: null, can_add_listing: false }, { now, hasApprovedPayment: true }).status, 'expired');
  assert.strictEqual(trial.billingState({ trial_ends_at: null, can_add_listing: true }, { now }).status, 'none');
});

test('dashboard banner text: X days left, ends today, expired, nothing for paid', () => {
  const now = new Date();
  const b = (d) => ({ ...trial.billingState({ trial_ends_at: new Date(now.getTime() + d * DAY), can_add_listing: true }, { now }) });
  assert.match(bannerText(b(3)).en, /3 days left/);
  assert.match(bannerText(b(3)).hi, /3 din baaki/);
  assert.match(bannerText(b(1)).en, /1 day left/);
  assert.strictEqual(bannerText(b(3)).tone, 'info');
  assert.strictEqual(bannerText(b(1)).tone, 'warning');
  assert.strictEqual(bannerText({ status: 'expired', reason: 'trial_ended' }).tone, 'danger');
  assert.strictEqual(bannerText({ status: 'paid' }).show, false);
});

test('trial messages carry the end date and the payment link', () => {
  const end = new Date('2026-10-28T10:00:00Z');
  const reminder = trial.trialReminderMessage(2, { v: 'hi', trialEndsAt: end, payLine: '💳 Yahan pay karein: https://rzp.io/i/abc' });
  assert.match(reminder, /2 din/);
  assert.match(reminder, /28 Oct/);
  assert.match(reminder, /https:\/\/rzp\.io\/i\/abc/);
  assert.match(trial.trialReminderMessage(1, { v: 'en', trialEndsAt: end }), /1 day/);
  assert.match(trial.trialExpiredMessage({ v: 'pa', trialEndsAt: end }), /[਀-੿]/);
});

// ----------------------------------------------------------- converted dealers

test('converted dealers without a trial get one; paid or already-trialling dealers are left alone', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  const stuck = { role: 'owner', trial_ends_at: null, can_add_listing: false, package_id: 'old-pkg' };
  const fix = planTrialRepair(stuck, { now });
  assert.strictEqual(fix.needsTrial, true);
  assert.strictEqual(fix.patch.can_add_listing, true);
  assert.strictEqual(fix.patch.package_id, null);
  assert.strictEqual(fix.patch.trial_ends_at.getTime() - now.getTime(), 7 * DAY);
  assert.strictEqual(planTrialRepair(stuck, { now, hasApprovedPayment: true }).needsTrial, false);
  assert.strictEqual(planTrialRepair({ ...stuck, trial_ends_at: now }, { now }).needsTrial, false);
  assert.strictEqual(planTrialRepair({ ...stuck, role: 'agent' }, { now }).needsTrial, false);
  assert.strictEqual(planTrialRepair(stuck, { now, tenantPlanKnown: false }).tenantPlan, 'multi_user_basic');
});

// ----------------------------------------------------------- seller bug A helper

test('bug A: only real sale details continue a sale', () => {
  for (const x of ['200 gaj', '1.5 crore', 'plot hai Dugri mein', 'kothi bechni hai']) assert.strictEqual(looksLikeSaleDetails(x), true, x);
  for (const x of ['hi', 'hello', 'plan kya hai', 'join', 'trial kitne din ka hai', 'ok']) assert.strictEqual(looksLikeSaleDetails(x), false, x);
});
