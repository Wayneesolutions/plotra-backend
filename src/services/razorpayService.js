// src/services/razorpayService.js
//
// Razorpay payment links for dealer plans.
//
// The Razorpay ACCOUNT IS SHARED with Waynur, so every payment event for both
// products reaches every webhook endpoint registered on the account. Plotraa
// therefore (1) puts notes.product = 'plotraa' on every link it creates and
// only acts on events carrying that note, and (2) only acts on links that
// exist in its own razorpay_payment_links table. Everything else is
// acknowledged and ignored.
//
// Flow: dealer picks a plan on WhatsApp (or a trial reminder fires) ->
// getOrCreatePaymentLink -> link sent -> Razorpay calls
// POST /api/v1/webhooks/razorpay with payment_link.paid ->
// activatePaidLink marks the dealer paid and switches the plan on.
//
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (API), RAZORPAY_WEBHOOK_SECRET
// (the secret set on the webhook in the Razorpay dashboard).

const axios = require('axios');
const crypto = require('crypto');

const PRODUCT_NOTE = 'plotraa';
const API_BASE = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1';
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REUSE_MIN_REMAINING_MS = 24 * 60 * 60 * 1000;

function isConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

/** Pure: HMAC-SHA256 hex of the raw body, compared in constant time. */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  } catch {
    return false; // length mismatch
  }
}

/** Pure: is this payload one of Plotraa's (not Waynur's)? */
function isPlotraaNotes(notes) {
  return Boolean(notes) && String(notes.product || '').toLowerCase() === PRODUCT_NOTE;
}

/**
 * Pure: reads a Razorpay webhook body into what we need.
 * Returns { event, linkId, paymentId, amountPaise, notes, status } (fields null when absent).
 */
function parseWebhookEvent(body) {
  const link = body?.payload?.payment_link?.entity || null;
  const payment = body?.payload?.payment?.entity || null;
  const paid = Number(link?.amount_paid);
  const amountPaise = Number.isFinite(paid) && paid > 0 ? paid : (Number(payment?.amount) || null);
  return {
    event: body?.event || null,
    linkId: link?.id || null,
    paymentId: payment?.id || null,
    amountPaise,
    // The link's own notes are authoritative; the payment's are a fallback.
    notes: link?.notes && Object.keys(link.notes).length ? link.notes : (payment?.notes || null),
    status: link?.status || null,
  };
}

async function createPaymentLink({ amountInr, planKey, planLabel, user, tenantId, referenceId }) {
  if (!isConfigured()) throw new Error('Razorpay is not configured (set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET).');
  const expireBy = Math.floor((Date.now() + LINK_TTL_MS) / 1000);
  const response = await axios.post(`${API_BASE}/payment_links`, {
    amount: Math.round(Number(amountInr) * 100),
    currency: 'INR',
    accept_partial: false,
    reference_id: referenceId,
    description: `Plotraa ${planLabel || planKey} plan (monthly)`.slice(0, 250),
    customer: { name: user.name || undefined, contact: user.phone || undefined },
    notify: { sms: false, email: false },
    reminder_enable: false,
    expire_by: expireBy,
    notes: {
      product: PRODUCT_NOTE,
      user_id: user.id,
      tenant_id: tenantId,
      plan_key: planKey,
    },
  }, {
    auth: { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET },
    timeout: 15000,
  });
  const d = response.data;
  return { id: d.id, shortUrl: d.short_url, expiresAt: new Date(expireBy * 1000) };
}

/**
 * The open payment link for this dealer + plan: reuses one that is still
 * valid for at least a day, otherwise creates a new one. Throws when Razorpay
 * is not configured or the plan is unknown; callers fall back to QR/receipt.
 * Returns { url, plan }.
 */
async function getOrCreatePaymentLink(knex, { user, planKey }) {
  const plan = await knex('plans').where({ key: planKey, is_active: true }).first('key', 'label', 'price_inr');
  if (!plan) throw new Error(`Unknown or inactive plan "${planKey}".`);

  const reusable = await knex('razorpay_payment_links')
    .where({ user_id: user.id, plan_key: plan.key, status: 'created' })
    .where('amount_inr', plan.price_inr)
    .where('expires_at', '>', new Date(Date.now() + REUSE_MIN_REMAINING_MS))
    .orderBy('created_at', 'desc').first('short_url');
  if (reusable) return { url: reusable.short_url, plan };

  const referenceId = `pl_${crypto.randomBytes(10).toString('hex')}`;
  const link = await createPaymentLink({
    amountInr: plan.price_inr, planKey: plan.key, planLabel: plan.label, user, tenantId: user.tenant_id, referenceId,
  });
  await knex('razorpay_payment_links').insert({
    user_id: user.id,
    tenant_id: user.tenant_id,
    plan_key: plan.key,
    amount_inr: plan.price_inr,
    razorpay_link_id: link.id,
    reference_id: referenceId,
    short_url: link.shortUrl,
    expires_at: link.expiresAt,
  });
  return { url: link.shortUrl, plan };
}

/**
 * Marks a paid link as a payment and switches the dealer on: payment
 * approved, can_add_listing back on, selected plan stored, and (for a
 * dealer's own account) the tenant moved onto the paid plan. Idempotent on
 * the link: a repeated webhook changes nothing.
 *
 * Returns { status: 'activated', user, plan } | { status: 'duplicate' } |
 * { status: 'ignored', reason }.
 */
async function activatePaidLink(knex, { linkId, paymentId, amountPaise }) {
  return knex.transaction(async (trx) => {
    const link = await trx('razorpay_payment_links').where({ razorpay_link_id: linkId }).forUpdate().first();
    if (!link) return { status: 'ignored', reason: 'unknown_link' };
    if (link.status === 'paid') return { status: 'duplicate' };
    if (amountPaise != null && amountPaise < link.amount_inr * 100) {
      return { status: 'ignored', reason: 'amount_mismatch', link };
    }

    await trx('razorpay_payment_links').where({ id: link.id }).update({
      status: 'paid', razorpay_payment_id: paymentId || null, paid_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
    await trx('payment_submissions').insert({
      tenant_id: link.tenant_id,
      agent_id: link.user_id,
      receipt_photo_url: null,
      amount_inr: link.amount_inr,
      status: 'approved',
      reviewed_at: trx.fn.now(),
      plan_key: link.plan_key,
      source: 'razorpay',
      razorpay_payment_id: paymentId || null,
    });
    await trx('users').where({ id: link.user_id }).update({
      payment_status: 'paid', can_add_listing: true, selected_plan_key: link.plan_key,
      trial_reminder_day: null, updated_at: trx.fn.now(),
    });
    const user = await trx('users').where({ id: link.user_id }).first('id', 'name', 'phone', 'role', 'tenant_id');
    if (user?.role === 'owner') {
      await trx('tenants').where({ id: user.tenant_id }).update({ plan: link.plan_key, updated_at: trx.fn.now() });
    }
    const plan = await trx('plans').where({ key: link.plan_key }).first('key', 'label');
    return { status: 'activated', user, plan: plan || { key: link.plan_key, label: link.plan_key } };
  });
}

module.exports = {
  PRODUCT_NOTE,
  isConfigured,
  verifyWebhookSignature,
  isPlotraaNotes,
  parseWebhookEvent,
  createPaymentLink,
  getOrCreatePaymentLink,
  activatePaidLink,
};
