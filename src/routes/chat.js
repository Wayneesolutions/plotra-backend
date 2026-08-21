const express = require('express');
const router = express.Router();
const { handleWebChatMessage, handleWebChatPhotoUpload } = require('../controllers/webChatController');
const { uploadMiddleware } = require('../controllers/mediaController');
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

/**
 * @route   POST /api/v1/chat/web/photo
 * @desc    Lets a dealer attach a real property photo to their in-progress
 *          (or already-published) web-chat listing. multipart/form-data:
 *          `photo` (file, required — see mediaController.js's
 *          uploadMiddleware for size/type limits) and `session_id`
 *          (required — same session id the text chat uses, resolves which
 *          listing to attach to).
 * @access  Public, same reasoning as POST /web above.
 */
router.post('/web/photo', publicWriteLimiter, uploadMiddleware, serviceContext, handleWebChatPhotoUpload);

module.exports = router;
