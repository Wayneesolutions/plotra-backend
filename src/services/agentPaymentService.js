// src/services/agentPaymentService.js
//
// Shared logic for the agent payment/subscription system — used from both
// the WhatsApp webhook path (webhookController.js, package selection +
// receipt submission) and the daily reminder/restriction cron
// (paymentReminderWorker.js), so the cycle-day math and package-menu
// formatting live in exactly one place.
const { enqueueAgentWhatsappSend } = require('./agentMessagingService');
const { t } = require('../utils/i18n');
// Lazy: keeps this file's load order unchanged.
const raiseSupportRequest = (...a) => require('./supportRequestService').raiseSupportRequest(...a);

// Exact-match keywords (same convention as agentReplyIntent.js's
// APPROVAL_KEYWORDS) — deliberately a Set of whole normalized phrases, not
// a substring match, so a property description that happens to contain
// the word "paid" (e.g. "registry paid already") doesn't accidentally
// trigger the receipt-submission flow.
const RECEIPT_SUBMISSION_KEYWORDS = new Set([
  'payment', 'submit payment', 'send payment', 'send receipt', 'submit receipt',
  'receipt', 'paid', 'payment done', 'i have paid', 'i paid', 'pay',
  'bhugtan', 'payment kar diya', 'paise bhej diye', 'receipt bhejna hai', 'rasid', 'maine paid kar diya',
]);

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/^[!.,?\s]+|[!.,?\s]+$/g, '');
}

function isReceiptSubmissionIntent(text) {
  return RECEIPT_SUBMISSION_KEYWORDS.has(normalize(text));
}

/**
 * Active plans in menu order. 22 Oct fix (bug B): the menu used to come from
 * the old hardcoded `packages` table (Lite 3000 / Growth 10000 / Unlimited
 * 20000). It now reads the LIVE `plans` table, the same catalogue the website
 * pricing page, the admin Plans tab and the assistant use, so a price change
 * in Admin shows up on WhatsApp immediately. This is also what a numeric
 * reply is matched against (index into this same query, so the two never
 * drift apart).
 */
async function getActivePlansInMenuOrder(knex) {
  return knex('plans').where({ is_active: true }).orderBy('sort_order', 'asc');
}

// Kept for older call sites.
const getActivePackagesInMenuOrder = getActivePlansInMenuOrder;

/** Pure: "1. *Basic* — ₹5,000/month (40% off) · 1 user" from plan rows. */
function formatPackageMenu(plans) {
  return plans.map((p, i) => {
    const extras = [
      p.max_users ? `${p.max_users} user${p.max_users > 1 ? 's' : ''}` : null,
      p.included_leads ? `${p.included_leads} leads` : null,
    ].filter(Boolean);
    const price = `₹${Number(p.price_inr).toLocaleString('en-IN')}/month`;
    return `${i + 1}. *${p.label}* — ${price}${p.discount_percent ? ` (${p.discount_percent}% off)` : ''}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
  }).join('\n');
}

/** Pure: the full plan-list message (header, live plans, footer) in one variant. */
function buildPlanMenuMessage(plans, v, { headerKey = 'plan_menu_header', footerKey = 'plan_menu_footer', vars = {} } = {}) {
  return `${t(headerKey, v)}\n\n${formatPackageMenu(plans)}\n\n${t(footerKey, v, vars)}`;
}

/** Pure: the plan a message picks: "2" (only before a plan is chosen) or "plan 2" (any time). */
function parsePlanChoice(text, { alreadyChosen }) {
  const trimmed = String(text || '').trim().toLowerCase();
  const explicit = trimmed.match(/^(?:plan|ਪਲਾਨ|प्लान)\s*(?:no\.?|number|#)?\s*(\d{1,2})$/i);
  if (explicit) return Number(explicit[1]);
  if (!alreadyChosen && /^\d{1,2}$/.test(trimmed)) return Number(trimmed);
  return null;
}

/**
 * Sent once right after an agent is approved (the super-admin approval in
 * agentSignupController.js calls this).
 */
async function sendPackageSelectionPrompt(knex, { tenantId, phone, v = 'hi' }) {
  const plans = await getActivePlansInMenuOrder(knex);
  if (!plans.length) {
    // No active plan at all is a real misconfiguration: log loudly and still
    // send the dealer something instead of radio silence.
    console.warn(`[agentPaymentService] No active plans configured: dealer ${phone} was approved but has nothing to choose from.`);
    await enqueueAgentWhatsappSend({ tenantId, phone, messageBody: t('plan_none', v) });
    return;
  }
  await enqueueAgentWhatsappSend({ tenantId, phone, messageBody: buildPlanMenuMessage(plans, v) });
}

/**
 * Claims a plan-choice reply ("2" before a plan is chosen, "plan 2" any time)
 * and sends the way to pay: a Razorpay payment link when configured (the plan
 * switches on automatically when it is paid), else the plan's QR, else the
 * team is asked to send one. Returns false (does nothing) for anything else,
 * so a genuine listing-intake message ("plot no 12...") is never swallowed;
 * see webhookController.js for how the return value is used.
 */
async function tryHandlePackageSelectionReply(knex, { agentUser, incomingText }) {
  const alreadyChosen = Boolean(agentUser.selected_plan_key || agentUser.package_id);
  const number = parsePlanChoice(incomingText, { alreadyChosen });
  if (!number) return false;

  const plans = await getActivePlansInMenuOrder(knex);
  const chosen = plans[number - 1];
  if (!chosen) return false;

  const v = await require('./contactVariantService').getContactVariant(knex, agentUser.phone, incomingText);
  await knex('users').where({ id: agentUser.id }).update({ selected_plan_key: chosen.key, updated_at: knex.fn.now() });
  const vars = { plan: chosen.label, price: Number(chosen.price_inr).toLocaleString('en-IN') };

  let body = null;
  const razorpay = require('./razorpayService');
  if (razorpay.isConfigured()) {
    try {
      const { url } = await razorpay.getOrCreatePaymentLink(knex, { user: agentUser, planKey: chosen.key });
      body = t('plan_selected_link', v, { ...vars, link: url });
    } catch (err) {
      console.error('[agentPaymentService] Razorpay link failed, falling back to QR:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    }
  }
  if (!body && chosen.qr_code_url) {
    body = t('plan_selected_qr', v, { ...vars, qr: chosen.qr_code_url });
  }
  if (!body) {
    // Nothing to pay with yet. Don't promise "shortly" and then go silent:
    // tell the team so they send the details, and say so honestly.
    console.warn(`[agentPaymentService] Plan "${chosen.label}" (${chosen.key}) has no Razorpay link or QR; ${agentUser.phone} selected it.`);
    await raiseSupportRequest(knex, {
      phone: agentUser.phone,
      name: agentUser.name,
      audience: 'agent',
      kind: 'problem',
      summary: `Selected the "${chosen.label}" plan but there is no payment link or QR for it. Please send the payment details.`,
      lastMessage: String(incomingText).trim(),
      tenantId: agentUser.tenant_id,
      userId: agentUser.id,
    }).catch((err) => console.error('[agentPaymentService] could not raise payment-details support request:', err.message));
    body = t('plan_selected_noqr', v, vars);
  }
  await enqueueAgentWhatsappSend({ tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: body });
  return true;
}

/**
 * Days since the agent's current cycle anchor — onboarded_at for a never-
 * -yet-paid agent, or their most recent approved payment's review date
 * once they've paid at least once (see PR spec: "next due = approval date
 * + 1 month"). Whole days, floor()'d — a reminder scheduled for "day 28"
 * should fire once 28 full days have elapsed, not on the 27th at 23:59.
 */
function daysSinceCycleAnchor(anchorDate) {
  const anchor = new Date(anchorDate).getTime();
  const now = Date.now();
  return Math.floor((now - anchor) / (24 * 60 * 60 * 1000));
}

/**
 * The anchor date this agent's billing cycle counts from — their most
 * recent APPROVED payment_submissions row's reviewed_at if they've ever
 * paid, otherwise onboarded_at. Re-derived fresh each time rather than
 * stored, so approving a late payment automatically resets the cycle
 * without a separate write.
 */
async function getCycleAnchorDate(knex, agentId, onboardedAt) {
  const lastApproved = await knex('payment_submissions')
    .where({ agent_id: agentId, status: 'approved' })
    .orderBy('reviewed_at', 'desc')
    .first();
  return lastApproved?.reviewed_at || onboardedAt;
}

module.exports = {
  isReceiptSubmissionIntent,
  getActivePlansInMenuOrder,
  getActivePackagesInMenuOrder,
  formatPackageMenu,
  buildPlanMenuMessage,
  parsePlanChoice,
  sendPackageSelectionPrompt,
  tryHandlePackageSelectionReply,
  daysSinceCycleAnchor,
  getCycleAnchorDate,
};
