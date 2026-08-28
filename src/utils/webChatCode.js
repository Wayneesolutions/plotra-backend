// src/utils/webChatCode.js
//
// Generates the per-tenant web chat activation code (tenants.web_chat_code)
// — see webChatCodeController.js and webChatController.js.
const crypto = require('crypto');

// Uppercase alphanumeric, excludes visually-ambiguous characters (0/O,
// 1/I/L) — this gets typed by hand into the widget's activation prompt, so
// legibility matters more than raw entropy. 8 chars from this 32-symbol
// alphabet is still ~40 bits, plenty for a code that only needs to be as
// hard to guess as e.g. a support PIN, not secret-grade.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateWebChatCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

/**
 * Generates a code guaranteed not to collide with an existing one.
 * Collision is astronomically unlikely across any realistic number of
 * tenants, but the check-and-retry costs nothing to be sure — the column
 * has a unique index, so an unlucky collision would otherwise surface as a
 * raw DB constraint error instead of just quietly retrying.
 */
async function generateUniqueWebChatCode(knex) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateWebChatCode();
    const existing = await knex('tenants').where({ web_chat_code: code }).first();
    if (!existing) return code;
  }
  throw new Error('Failed to generate a unique web chat code after 5 attempts.');
}

function normalizeWebChatCode(code) {
  return String(code || '').trim().toUpperCase();
}

module.exports = { generateWebChatCode, generateUniqueWebChatCode, normalizeWebChatCode };
