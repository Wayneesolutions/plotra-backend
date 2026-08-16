const express = require('express');
const router = express.Router();
const authGuard = require('../middleware/auth');
const { login, changePassword, updatePhone, forgotPassword, resetPassword } = require('../controllers/authController');
// NEW — Phase 7
const { loginLimiter, publicWriteLimiter } = require('../middleware/rateLimiter');

/**
 * @route   POST /api/v1/auth/login
 * @desc    Authenticate dashboard managers & agents and return scoped access tokens
 * @access  Public
 */
router.post('/login', loginLimiter, login);

/**
 * @route   POST /api/v1/auth/change-password
 * @desc    Change your own password (requires current password)
 * @access  Protected
 */
router.post('/change-password', authGuard, changePassword);

/**
 * @route   POST /api/v1/auth/update-phone
 * @desc    Set/change the WhatsApp number your agent-intake messages are
 *          recognized from (see webhookController.js)
 * @access  Protected
 */
router.post('/update-phone', authGuard, updatePhone);

/**
 * @route   POST /api/v1/auth/forgot-password
 * @desc    Request a password reset link by email
 * @access  Public
 */
router.post('/forgot-password', publicWriteLimiter, forgotPassword);

/**
 * @route   POST /api/v1/auth/reset-password
 * @desc    Consume a reset token and set a new password
 * @access  Public
 */
router.post('/reset-password', publicWriteLimiter, resetPassword);

module.exports = router;
