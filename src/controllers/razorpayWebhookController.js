// src/controllers/razorpayWebhookController.js
//
// POST /api/v1/webhooks/razorpay
//
// The Razorpay account is shared with Waynur, so this endpoint sees every
// payment event of both products. It only acts on payment links Plotraa made
// (notes.product === 'plotraa' AND a row in razorpay_payment_links) and
// acknowledges everything else with 200 so Razorpay does not keep retrying.
// The signature is checked against RAZORPAY_WEBHOOK_SECRET on the RAW body;
// without that secret nothing is processed (money events are never trusted
// unsigned).

const {
  verifyWebhookSignature, isPlotraaNotes, parseWebhookEvent, activatePaidLink,
} = require('../services/razorpayService');
const { buildTemplate } = require('../services/whatsappTemplates');
const { variantFor, t } = require('../utils/i18n');

const enqueueWhatsapp = (...a) => require('../services/agentMessagingService').enqueueAgentWhatsappSend(...a);

async function notifyPaid(user, plan, lastText) {
  if (!user?.phone) return;
  const body = t('paid_confirmed', variantFor(lastText || ''), { plan: plan.label });
  await enqueueWhatsapp({
    tenantId: user.tenant_id,
    phone: user.phone,
    messageBody: body,
    template: buildTemplate('payment_received', { name: user.name || 'Dealer', plan_label: plan.label }),
  });
}

async function handleRazorpayWebhook(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Razorpay] RAZORPAY_WEBHOOK_SECRET is not set: refusing to process the webhook.');
    return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Razorpay webhook secret is not configured.' } });
  }
  if (!verifyWebhookSignature(req.rawBody, req.headers['x-razorpay-signature'], secret)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature.' } });
  }

  const ev = parseWebhookEvent(req.body);

  // Waynur's payments (and anything else on the shared account).
  if (!isPlotraaNotes(ev.notes)) {
    return res.status(200).json({ success: true, ignored: 'not_plotraa' });
  }

  try {
    if (ev.event === 'payment_link.paid') {
      if (!ev.linkId) return res.status(200).json({ success: true, ignored: 'no_link_id' });
      const result = await activatePaidLink(knex, { linkId: ev.linkId, paymentId: ev.paymentId, amountPaise: ev.amountPaise });
      if (result.status === 'activated') {
        console.log('[Razorpay] activated plan %s for user %s (payment %s)', result.plan.key, result.user?.id, ev.paymentId);
        try { await notifyPaid(result.user, result.plan); } catch (err) { console.error('[Razorpay] paid notification failed (non-fatal):', err.message); }
      } else if (result.reason === 'amount_mismatch') {
        console.error('[Razorpay] paid amount %s is less than the link amount for link %s: not activated.', ev.amountPaise, ev.linkId);
      }
      return res.status(200).json({ success: true, result: result.status, reason: result.reason });
    }

    if (ev.event === 'payment_link.expired' || ev.event === 'payment_link.cancelled') {
      const status = ev.event === 'payment_link.expired' ? 'expired' : 'cancelled';
      if (ev.linkId) {
        await knex('razorpay_payment_links').where({ razorpay_link_id: ev.linkId, status: 'created' })
          .update({ status, updated_at: knex.fn.now() });
      }
      return res.status(200).json({ success: true, result: status });
    }

    return res.status(200).json({ success: true, ignored: ev.event || 'unknown_event' });
  } catch (error) {
    // 500 so Razorpay retries; activatePaidLink is idempotent.
    console.error('[Razorpay] webhook processing failed:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not process the event.' } });
  }
}

module.exports = { handleRazorpayWebhook };
