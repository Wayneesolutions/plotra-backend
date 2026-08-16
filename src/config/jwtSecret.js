/**
 * SECURITY FIX: both src/middleware/auth.js and src/controllers/authController.js
 * previously defined their own copy of:
 *   const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_production';
 *
 * That fallback string is sitting in this public GitHub repo. If JWT_SECRET
 * was ever unset in a real deployment, every token issued (and every token
 * accepted) would use that exact, publicly-known string as the signing
 * secret — anyone who's seen this repo could forge a valid login token for
 * any user. Fails fast at startup instead, and is now defined in exactly
 * one place so the two files can't drift out of sync with each other.
 */

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET must be set in the environment. Refusing to start with no secret — ' +
    'a missing secret previously fell back to a hardcoded string committed to this ' +
    'public repo, which made every token forgeable. See .env.example.'
  );
}

module.exports = { JWT_SECRET };
