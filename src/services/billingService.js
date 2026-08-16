const Stripe = require('stripe');

/**
 * FIX (gap #3 — plans hardcoded): plan pricing/limits/features used to be
 * hardcoded constants in this file. They now live in the `plans` table
 * (see migration 20260708_01) so an admin can change a price or a listing
 * limit without a code deploy. This file only talks to the DB now; there
 * is no fallback hardcoded plan data on purpose — if the plans table is
 * empty, that's a real misconfiguration that should surface as an error,
 * not silently serve stale prices nobody can find in the code.
 */
async function listPlans(knex) {
  const rows = await knex('plans').where({ is_active: true }).orderBy('sort_order', 'asc');
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    priceINR: r.price_inr,
    listingLimit: r.listing_limit, // null = unlimited
    features: r.features,
  }));
}

async function getPlan(knex, planKey) {
  return knex('plans').where({ key: planKey, is_active: true }).first();
}

function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured — set STRIPE_SECRET_KEY.');
  }
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

/**
 * FIX (gap #6 — no auto-renewal): this previously created a one-time
 * Checkout Session (mode: 'payment') — the tenant had to come back and
 * manually pay again every 30 days, with nothing prompting them to. Now
 * creates a recurring subscription Checkout Session instead; Stripe bills
 * the saved card automatically every 30 days and fires invoice.paid /
 * customer.subscription.deleted webhooks that keep subscription_status and
 * current_period_end in sync without any manual step.
 */
async function createCheckoutSession({ plan, planRow, paymentEventId, userEmail, stripeCustomerId, successUrl, cancelUrl }) {
  const stripe = getStripeClient();
  const amountPaise = planRow.price_inr * 100;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId || undefined,
    customer_email: stripeCustomerId ? undefined : userEmail,
    line_items: [{
      price_data: {
        currency: 'inr',
        product_data: {
          name: `PropertyPro ${planRow.label} Plan`,
          description: 'Billed every 30 days — cancel anytime from the billing dashboard.',
        },
        unit_amount: amountPaise,
        recurring: { interval: 'month' },
      },
      quantity: 1,
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { plan, payment_event_id: paymentEventId },
    subscription_data: {
      metadata: { plan, payment_event_id: paymentEventId },
    },
  });

  return { sessionId: session.id, url: session.url, amountPaise };
}

/**
 * Cancels a tenant's Stripe subscription at the end of the current billing
 * period (they keep access until current_period_end, then it stops
 * auto-renewing) rather than cutting them off immediately.
 */
async function cancelSubscription(stripeSubscriptionId) {
  const stripe = getStripeClient();
  return stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
}

/**
 * Verifies a Stripe webhook signature using the raw request body.
 * Throws if invalid — caller should return 400.
 * If STRIPE_WEBHOOK_SECRET is not set, skips verification (dev mode).
 */
function constructStripeEvent(rawBody, signatureHeader) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) return null;
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = {
  listPlans,
  getPlan,
  createCheckoutSession,
  cancelSubscription,
  constructStripeEvent,
};
