const { v4: uuidv4 } = require('uuid');
const {
  listPlans,
  getPlan,
  createCheckoutSession,
  cancelSubscription,
  constructStripeEvent,
} = require('../services/billingService');
const { sendPaymentReceiptEmail } = require('../services/emailService');

/**
 * GET /api/v1/public/billing/plans
 * Public — powers both the landing page pricing table and the billing modal.
 * Reads from the `plans` table now (gap #3) instead of hardcoded constants.
 */
async function getPlans(req, res) {
  const knex = req.app.get('db');
  try {
    const plans = await listPlans(knex);
    return res.json({ success: true, plans });
  } catch (error) {
    console.error('Failed to fetch plans:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch plans.' } });
  }
}

/**
 * POST /api/v1/dashboard/billing/create-checkout-session
 * Owner-only. Creates a Stripe subscription Checkout Session (gap #6 —
 * auto-renewal) and returns the hosted URL.
 */
async function createCheckoutSessionHandler(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { plan, successUrl, cancelUrl } = req.body;

  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the account owner can manage billing.' } });
  }

  if (!successUrl || !cancelUrl) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'successUrl and cancelUrl are required.' },
    });
  }

  try {
    const planRow = await getPlan(knex, plan);
    if (!planRow) {
      const available = (await listPlans(knex)).map((p) => p.key).join(', ');
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `plan must be one of: ${available}.` },
      });
    }

    const paymentEventId = uuidv4();
    const owner = await knex('users').where({ tenant_id: req.user.tenant_id, role: 'owner' }).first();
    const tenant = await knex('tenants').where({ id: req.user.tenant_id }).first();

    const { sessionId, url, amountPaise } = await createCheckoutSession({
      plan,
      planRow,
      paymentEventId,
      userEmail: owner?.email || req.user.email,
      stripeCustomerId: tenant?.stripe_customer_id || null,
      successUrl,
      cancelUrl,
    });

    await knex('payment_events').insert({
      id: paymentEventId,
      tenant_id: req.user.tenant_id,
      stripe_session_id: sessionId,
      plan,
      amount_paise: amountPaise,
      status: 'created',
    });

    return res.status(201).json({ success: true, url });
  } catch (error) {
    console.error('Failed to create Stripe checkout session:', error.message);
    return res.status(500).json({ error: { code: 'CHECKOUT_CREATE_FAILED', message: 'Failed to start payment. Please try again.' } });
  }
}

/**
 * POST /api/v1/dashboard/billing/cancel-subscription
 * Owner-only. Cancels at period end — access continues until
 * current_period_end, then subscription_status flips to 'cancelled' via
 * the customer.subscription.deleted webhook.
 */
async function cancelSubscriptionHandler(req, res) {
  const knex = req.dbTrx || req.app.get('db');

  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the account owner can manage billing.' } });
  }

  try {
    const tenant = await knex('tenants').where({ id: req.user.tenant_id }).first();
    if (!tenant?.stripe_subscription_id) {
      return res.status(400).json({ error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription to cancel.' } });
    }

    await cancelSubscription(tenant.stripe_subscription_id);
    await knex('tenants').where({ id: req.user.tenant_id }).update({ subscription_status: 'cancelling', updated_at: knex.fn.now() });

    return res.json({ success: true, message: 'Subscription will end on your current billing date and will not renew.' });
  } catch (error) {
    console.error('Failed to cancel subscription:', error.message);
    return res.status(500).json({ error: { code: 'CANCEL_FAILED', message: 'Failed to cancel subscription.' } });
  }
}

/**
 * GET /api/v1/dashboard/billing/status
 * Any authenticated dashboard user can view billing status.
 */
async function getBillingStatus(req, res) {
  const knex = req.dbTrx || req.app.get('db');

  try {
    const tenant = await knex('tenants')
      .select('plan', 'subscription_status', 'current_period_end')
      .where({ id: req.user.tenant_id })
      .first();

    const history = await knex('payment_events')
      .select('plan', 'amount_paise', 'status', 'created_at')
      .where({ tenant_id: req.user.tenant_id, status: 'paid' })
      .orderBy('created_at', 'desc')
      .limit(5);

    return res.json({ success: true, billing: tenant, history });
  } catch (error) {
    console.error('Failed to fetch billing status:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch billing status.' } });
  }
}

/**
 * POST /api/v1/webhooks/stripe
 * Public — signature-verified via STRIPE_WEBHOOK_SECRET. Runs under
 * serviceContext (see routes/webhooks.js) since a webhook can arrive for
 * any tenant.
 *
 * Handles the full subscription lifecycle (gap #6 — auto-renewal):
 *   checkout.session.completed  — first payment, activates the plan and
 *                                  stores the Stripe customer/subscription IDs
 *   invoice.paid                — every subsequent monthly renewal, extends
 *                                  current_period_end automatically
 *   customer.subscription.deleted — subscription actually ended (after a
 *                                  cancel-at-period-end, or a failed-payment
 *                                  dunning cycle exhausted) — flips status
 */
async function handleStripeWebhook(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = constructStripeEvent(req.rawBody, sig);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  if (!event) {
    event = req.body; // dev mode only — STRIPE_WEBHOOK_SECRET not set
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const paymentEventId = session.metadata?.payment_event_id;

      if (paymentEventId) {
        const paymentEvent = await knex('payment_events').where({ id: paymentEventId }).first();
        if (paymentEvent && paymentEvent.status !== 'paid') {
          await activateSubscription(knex, paymentEvent, {
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            stripePaymentIntentId: session.payment_intent,
          }, event);
        }
      }
    } else if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      await renewSubscriptionFromInvoice(knex, invoice);
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      await knex('tenants')
        .where({ stripe_subscription_id: subscription.id })
        .update({ subscription_status: 'cancelled', updated_at: knex.fn.now() });
    }

    // Always 200 — Stripe retries on non-2xx.
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Failed to process Stripe webhook:', error.message);
    return res.status(200).json({ received: true, trackingError: error.message });
  }
}

const BILLING_PERIOD_DAYS = 30;

/**
 * First payment on a new subscription — marks the payment_event paid,
 * activates the tenant's plan, and stores the Stripe customer/subscription
 * IDs for future renewals/cancellation. Idempotent.
 */
async function activateSubscription(knex, paymentEvent, stripeIds, rawWebhookPayload = null) {
  if (paymentEvent.status === 'paid') return;

  const newPeriodEnd = new Date(Date.now() + BILLING_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  let tenant;

  await knex.transaction(async (trx) => {
    await trx('payment_events')
      .where({ id: paymentEvent.id })
      .update({
        status: 'paid',
        stripe_payment_intent_id: stripeIds.stripePaymentIntentId || null,
        raw_webhook_payload: rawWebhookPayload ? JSON.stringify(rawWebhookPayload) : null,
        updated_at: trx.fn.now(),
      });

    [tenant] = await trx('tenants')
      .where({ id: paymentEvent.tenant_id })
      .update({
        plan: paymentEvent.plan,
        subscription_status: 'active',
        current_period_end: newPeriodEnd,
        stripe_customer_id: stripeIds.stripeCustomerId || null,
        stripe_subscription_id: stripeIds.stripeSubscriptionId || null,
        updated_at: trx.fn.now(),
      })
      .returning(['id', 'business_name', 'plan', 'subscription_status', 'current_period_end']);

    const owner = await trx('users').where({ tenant_id: tenant.id, role: 'owner' }).first();
    if (owner) {
      sendPaymentReceiptEmail({
        to: owner.email,
        businessName: tenant.business_name,
        plan: paymentEvent.plan,
        amountINR: paymentEvent.amount_paise / 100,
        currentPeriodEnd: newPeriodEnd,
      }).catch((err) => console.error('Payment receipt email failed (non-fatal):', err.message));
    }
  });
}

/**
 * Every recurring monthly charge fires invoice.paid — this is what makes
 * renewal automatic instead of requiring the tenant to come back and pay
 * manually every 30 days.
 */
async function renewSubscriptionFromInvoice(knex, invoice) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return; // one-off invoice, not a subscription renewal

  const tenant = await knex('tenants').where({ stripe_subscription_id: subscriptionId }).first();
  if (!tenant) return; // not one of ours, or not matched yet (first invoice — handled by checkout.session.completed instead)

  const newPeriodEnd = new Date(Date.now() + BILLING_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  await knex.transaction(async (trx) => {
    await trx('tenants')
      .where({ id: tenant.id })
      .update({ subscription_status: 'active', current_period_end: newPeriodEnd, updated_at: trx.fn.now() });

    await trx('payment_events').insert({
      tenant_id: tenant.id,
      stripe_session_id: `renewal_${invoice.id}`,
      plan: tenant.plan,
      amount_paise: invoice.amount_paid,
      status: 'paid',
      stripe_payment_intent_id: invoice.payment_intent || null,
    });

    const owner = await trx('users').where({ tenant_id: tenant.id, role: 'owner' }).first();
    if (owner) {
      sendPaymentReceiptEmail({
        to: owner.email,
        businessName: tenant.business_name,
        plan: tenant.plan,
        amountINR: invoice.amount_paid / 100,
        currentPeriodEnd: newPeriodEnd,
      }).catch((err) => console.error('Renewal receipt email failed (non-fatal):', err.message));
    }
  });
}

module.exports = { getPlans, createCheckoutSessionHandler, cancelSubscriptionHandler, getBillingStatus, handleStripeWebhook };
