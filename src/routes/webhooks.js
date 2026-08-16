const express = require('express');
const router = express.Router();
const { handleInboundWhatsApp } = require('../controllers/webhookController');
const { handleStripeWebhook } = require('../controllers/billingController');
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

module.exports = router;
