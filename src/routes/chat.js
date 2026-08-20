const express = require('express');
const router = express.Router();
const { handleWebChatMessage } = require('../controllers/webChatController');
const serviceContext = require('../middleware/serviceContext');
const { publicWriteLimiter } = require('../middleware/rateLimiter');

/**
 * @route   POST /api/v1/chat/web
 * @desc    Synchronous web-chat counterpart to the WhatsApp agent-intake
 *          flow — same extraction/listing-creation logic, called inline
 *          instead of via the async WhatsApp webhook -> BullMQ -> Graph API
 *          round trip. See BACKEND_API_SPEC.md.
 * @access  Public (no login — mirrors the WhatsApp number being public-facing).
 *          serviceContext because there's no authenticated tenant on the
 *          request to scope through; the demo tenant is resolved explicitly
 *          inside the controller instead.
 */
router.post('/web', publicWriteLimiter, serviceContext, handleWebChatMessage);

module.exports = router;
