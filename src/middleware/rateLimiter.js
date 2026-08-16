const rateLimit = require('express-rate-limit');

/**
 * Shared rate limiters. Kept intentionally generous — the goal is to stop
 * scripted abuse (bots hammering the lead-capture form, credential
 * stuffing on login), not to throttle a real burst of genuine buyer
 * traffic on a popular listing.
 *
 * IMPORTANT: if this API sits behind a reverse proxy / load balancer in
 * production (nginx, AWS ALB, etc.), `app.set('trust proxy', 1)` must be
 * set in app.js/server.js or every request will appear to come from the
 * proxy's IP and share one rate-limit bucket. Not added here automatically
 * since it depends on the actual deployment topology — flagging for Sant
 * to confirm before this goes live.
 */

const publicWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 writes per IP per 15 min — covers lead capture, calculator runs, ad events
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again in a few minutes.' } },
});

const publicReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120, // generous — a popular shared listing link can get real traffic bursts
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again in a few minutes.' } },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 login attempts per IP per 15 min — slows credential stuffing without locking out a real user who mistypes a password a few times
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again in a few minutes.' } },
});

module.exports = { publicWriteLimiter, publicReadLimiter, loginLimiter };
