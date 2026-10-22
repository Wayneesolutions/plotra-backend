// src/controllers/dealerBillingController.js
//
// What the dealer panel needs for the "X days left" trial banner and a
// "Pay now" button (22 Oct: the trial was invisible everywhere).
//
//   GET  /api/v1/dashboard/billing/trial          banner data, any panel user
//   POST /api/v1/dashboard/billing/payment-link   dealer (owner) only: a
//                                                 Razorpay link for a plan
//
// Sub-dealers see their dealer's state: their access follows the dealer's.

const { dealerBilling, shortDate } = require('../services/trialService');
const razorpay = require('../services/razorpayService');

/** Pure: the one-line banner text, English and Hinglish (the frontend may translate). */
function bannerText(billing) {
  if (billing.status === 'trial') {
    const left = billing.days_left;
    const when = shortDate(billing.trial_ends_at);
    return {
      show: true,
      tone: left <= 2 ? 'warning' : 'info',
      en: left <= 0 ? `Your free trial ends today (${when}).` : `Free trial: ${left} day${left === 1 ? '' : 's'} left (ends ${when}).`,
      hi: left <= 0 ? `Aapka free trial aaj (${when}) khatam ho raha hai.` : `Free trial: ${left} din baaki (${when} ko khatam).`,
    };
  }
  if (billing.status === 'expired') {
    return {
      show: true,
      tone: 'danger',
      en: billing.reason === 'payment_overdue'
        ? 'Your monthly payment is overdue: new listings are paused. Pay to switch them back on.'
        : 'Your free trial has ended: new listings are paused. Pay to switch them back on.',
      hi: billing.reason === 'payment_overdue'
        ? 'Monthly payment baaki hai: nayi listings ruki hain. Payment karke dobara chalu karein.'
        : 'Free trial khatam ho gaya: nayi listings ruki hain. Payment karke dobara chalu karein.',
    };
  }
  return { show: false };
}

/** GET /api/v1/dashboard/billing/trial */
async function getTrialStatus(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  try {
    const billing = await dealerBilling(knex, tenant_id);
    if (!billing) return res.json({ success: true, billing: { status: 'none' }, banner: { show: false } });

    const owner = billing.user;
    const tenant = await knex('tenants').where({ id: tenant_id }).first('plan');
    const planKey = owner.selected_plan_key || tenant?.plan || null;
    const plan = planKey ? await knex('plans').where({ key: planKey }).first('key', 'label', 'price_inr') : null;
    const openLink = await knex('razorpay_payment_links')
      .where({ user_id: owner.id, status: 'created' }).where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc').first('short_url', 'plan_key');

    const { user: _user, ...state } = billing;
    return res.json({
      success: true,
      billing: {
        ...state,
        payment_status: owner.payment_status,
        plan_key: plan?.key || null,
        plan_label: plan?.label || null,
        price_inr: plan?.price_inr ?? null,
        pay_url: openLink?.short_url || null,
        online_payment_enabled: razorpay.isConfigured(),
      },
      banner: bannerText(billing),
    });
  } catch (error) {
    console.error('Failed to load trial status:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load billing status.' } });
  }
}

/** POST /api/v1/dashboard/billing/payment-link  Body: { plan_key? } */
async function createPaymentLink(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role, id: userId } = req.user;
  if (role !== 'owner') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the dealer can pay for the plan.' } });
  }
  if (!razorpay.isConfigured()) {
    return res.status(503).json({ error: { code: 'ONLINE_PAYMENT_UNAVAILABLE', message: 'Online payment is not set up yet. Pay by QR / receipt on WhatsApp.' } });
  }
  try {
    const user = await knex('users').where({ id: userId, tenant_id }).first('id', 'name', 'phone', 'tenant_id', 'selected_plan_key');
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    const tenant = await knex('tenants').where({ id: tenant_id }).first('plan');
    const planKey = req.body?.plan_key || user.selected_plan_key || tenant?.plan;
    if (!planKey) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a plan first.' } });

    const { url, plan } = await razorpay.getOrCreatePaymentLink(knex, { user, planKey });
    if (req.body?.plan_key && req.body.plan_key !== user.selected_plan_key) {
      await knex('users').where({ id: user.id }).update({ selected_plan_key: plan.key, updated_at: knex.fn.now() });
    }
    return res.json({ success: true, url, plan: { key: plan.key, label: plan.label, price_inr: plan.price_inr } });
  } catch (error) {
    if (/Unknown or inactive plan/.test(error.message)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.message } });
    }
    console.error('Failed to create payment link:', error.response?.data || error.message);
    return res.status(502).json({ error: { code: 'PAYMENT_LINK_FAILED', message: 'Could not create the payment link. Try again in a minute.' } });
  }
}

module.exports = { getTrialStatus, createPaymentLink, bannerText };
