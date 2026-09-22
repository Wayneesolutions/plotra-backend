// src/services/agentPaymentService.js
//
// Shared logic for the agent payment/subscription system — used from both
// the WhatsApp webhook path (webhookController.js, package selection +
// receipt submission) and the daily reminder/restriction cron
// (paymentReminderWorker.js), so the cycle-day math and package-menu
// formatting live in exactly one place.
const { enqueueAgentWhatsappSend } = require('./agentMessagingService');

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
 * Active packages in menu order — the single source of truth for both the
 * WhatsApp numbered-list prompt and matching a numeric reply back to a
 * package (index-into-this-same-query, so the two never drift apart).
 */
async function getActivePackagesInMenuOrder(knex) {
  return knex('packages').where({ is_active: true }).orderBy('sort_order', 'asc');
}

function formatPackageMenu(packages) {
  return packages.map((p, i) => `${i + 1}. *${p.name}* — ₹${p.amount_inr}/month`).join('\n');
}

/**
 * Sent once right after an agent is approved (both the tenant-owner and
 * super-admin approval paths in agentSignupController.js call this).
 */
async function sendPackageSelectionPrompt(knex, { tenantId, phone }) {
  const packages = await getActivePackagesInMenuOrder(knex);
  if (!packages.length) {
    // Previously a silent no-op — this is the confirmed cause of "new
    // agent joins via WhatsApp, plan never shared, payment never happens":
    // if a tenant has no package marked is_active (never configured one,
    // or deactivated the only one), the agent gets approved and then hears
    // nothing further, ever, with zero signal anywhere that anything went
    // wrong. Log loudly (diagnosable from logs going forward, instead of
    // silently invisible) and still send the agent SOMETHING instead of
    // total radio silence — they at least know they aren't being ignored,
    // and can still list properties in the meantime (can_add_listing
    // defaults true until the payment-reminder cron actually restricts it).
    console.warn(`[agentPaymentService] No active packages configured for tenant ${tenantId} — agent ${phone} was approved but has nothing to select a payment plan from.`);
    await enqueueAgentWhatsappSend({
      tenantId,
      phone,
      messageBody: "You're approved! 🎉 Payment plan setup is still being finalized on our end — we'll message you shortly with package options. You can already send property details to list them in the meantime.",
    });
    return;
  }

  const body = `📦 *Choose your agent package* — reply with its number:\n\n${formatPackageMenu(packages)}\n\nYou can list properties either way; this just sets up your payment plan.`;
  await enqueueAgentWhatsappSend({ tenantId, phone, messageBody: body });
}

/**
 * Claims a bare numeric reply ("1", "2", ...) as a package selection —
 * only when this agent hasn't already picked one. Returns false (does
 * nothing) for anything that isn't a plain 1-2 digit number, or that
 * doesn't match an active package's current position in the menu, so a
 * genuine listing-intake message ("plot no 12...") is never swallowed by
 * this check — see webhookController.js for how the caller uses the
 * return value to decide whether to fall through to other handlers.
 */
async function tryHandlePackageSelectionReply(knex, { agentUser, incomingText }) {
  if (agentUser.package_id) return false;

  const trimmed = String(incomingText || '').trim();
  if (!/^\d{1,2}$/.test(trimmed)) return false;

  const packages = await getActivePackagesInMenuOrder(knex);
  const chosen = packages[Number(trimmed) - 1];
  if (!chosen) return false;

  await knex('users').where({ id: agentUser.id }).update({ package_id: chosen.id, updated_at: knex.fn.now() });

  const body = chosen.qr_code_url
    ? `✅ *${chosen.name}* package selected — ₹${chosen.amount_inr}/month.\n\nScan this QR to pay:\n${chosen.qr_code_url}\n\nOnce paid, send a photo of your payment receipt any time (or just type "payment") to confirm it with us.`
    : `✅ *${chosen.name}* package selected — ₹${chosen.amount_inr}/month. Your QR code will be shared shortly.`;
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
  getActivePackagesInMenuOrder,
  formatPackageMenu,
  sendPackageSelectionPrompt,
  tryHandlePackageSelectionReply,
  daysSinceCycleAnchor,
  getCycleAnchorDate,
};
