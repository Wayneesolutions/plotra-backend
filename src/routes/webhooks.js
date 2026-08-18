const express = require('express');
const router = express.Router();
const { handleInboundWhatsApp } = require('../controllers/webhookController');
const { handleStripeWebhook } = require('../controllers/billingController');
const { handleWayneRingWebhook } = require('../controllers/wayneRingWebhookController');
const serviceContext = require('../middleware/serviceContext');

/**
 * @route   POST /api/v1/webhooks/whatsapp/inbound
 * @desc    Receive inbound WhatsApp messages from the BSP and queue an AI reply
 * @access  Public (HMAC signature validated internally when WHATSAPP_WEBHOOK_SECRET is set)
 *
 * serviceContext is required here now that RLS denies cross-tenant access
 * by default — this route legitimately needs to look up ANY tenant by
 * their WhatsApp number to route an inbound message, which is exactly the
 * kind of cross-tenant read that RLS is supposed to restrict everywhere
 * else. The HMAC signature check inside the controller is this route's
 * real access control, not tenant matching.
 */
// Meta webhook verification — GET to same URL as POST
router.get('/whatsapp/inbound', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_SECRET) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/whatsapp/inbound', serviceContext, handleInboundWhatsApp);

/**
 * @route   POST /api/v1/webhooks/stripe
 * @desc    Authoritative payment confirmation from Stripe
 * @access  Public (HMAC signature validated internally via STRIPE_WEBHOOK_SECRET)
 *
 * Same reasoning as above — a Stripe webhook can arrive for any tenant's
 * payment, and the signature check is the real gate.
 */
router.post('/stripe', serviceContext, handleStripeWebhook);

/**
 * @route   POST /api/v1/webhooks/wayne-ring
 * @desc    Receive call.completed events from WayneRing (aivoicebackend
 *          PR #5) so an outbound/inbound AI call's outcome lands in
 *          ai_voice_calls near-instantly instead of waiting for the next
 *          wayneRingCallSyncWorker.js poll tick.
 * @access  Public (HMAC signature validated internally via
 *          WAYNERING_WEBHOOK_SECRET — see wayneRingWebhookController.js).
 *          No serviceContext middleware here: the sync functions this
 *          delegates to already open their own service-context transaction.
 */
router.post('/wayne-ring', handleWayneRingWebhook);

module.exports = router;
