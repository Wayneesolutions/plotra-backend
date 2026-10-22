// src/services/contactVariantService.js
//
// Which of the four fixed-text variants ('en' | 'hi' | 'pa' | 'hi_deva') to
// use for a person, when the message in hand is too short to tell ("2",
// "plan 3") or there is none (a trial reminder sent by a worker): look at
// what they last wrote to the bot. Defaults to Roman-script Hinglish, the
// language most Punjab dealers write in.

const { variant } = require('../utils/fixedReplies');
const { variantFor } = require('../utils/i18n');
const { detectScript, detectMessageLanguage, detectReplyLanguage } = require('../utils/replyLanguage');

/** Pure: variant from a list of recent inbound texts, newest first. */
function variantFromTexts(texts) {
  for (const text of texts) {
    const script = detectScript(text);
    const lang = detectMessageLanguage(text);
    if (script !== 'roman' || lang) return variant(script, lang || detectReplyLanguage(text));
  }
  return 'hi';
}

async function recentInboundTexts(knex, phone, limit = 5) {
  const rows = await knex('assistant_messages')
    .where({ phone, direction: 'inbound' }).orderBy('created_at', 'desc').limit(limit).select('body');
  return rows.map((r) => r.body);
}

async function getContactVariant(knex, phone, text = '') {
  if (text) {
    const script = detectScript(text);
    const lang = detectMessageLanguage(text);
    if (script !== 'roman' || lang) return variantFor(text);
  }
  try {
    const texts = await recentInboundTexts(knex, phone);
    return variantFromTexts(texts);
  } catch {
    return 'hi';
  }
}

module.exports = { getContactVariant, variantFromTexts };
