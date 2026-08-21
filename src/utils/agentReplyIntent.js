// src/utils/agentReplyIntent.js
//
// Recognizes an agent's WhatsApp reply as a pure approval, while an
// awaiting_approval draft's preview is waiting on them (see
// agentIntakeController.js). Deliberately EXACT match, not substring
// containment: a compound reply like "theek hai but change the price"
// contains an affirmative word but is really a correction — treating it
// as approval would publish the listing with the wrong price. Anything
// that isn't a pure "yes" is routed to the correction/re-extraction path
// instead. This is a documented v1 limitation (see the plan's deferred
// list) — a real intent-classification pass (e.g. via GPT) is the v2 fix
// for compound replies, not attempted here.

const APPROVAL_KEYWORDS = new Set([
  'approve', 'approved', 'yes', 'yep', 'ok', 'okay', 'confirm', 'confirmed', 'done', 'go',
  'haan', 'ha', 'haan ji', 'ji haan', 'theek hai', 'thik hai', 'sahi hai', 'ho gaya',
  // Compound-affirmative phrasing confirmed missing live (e.g. "haan sahi
  // hai" was misparsed as an edit instruction and reverted the reply to
  // Hindi mid-English-conversation) — these are still pure affirmatives,
  // just two of the words above said together, not a real correction like
  // "theek hai but change the price" which this file deliberately excludes.
  'haan sahi hai', 'sahi hai haan', 'ha sahi hai', 'haan ji sahi hai',
  'haan theek hai', 'theek hai haan', 'haan thik hai', 'thik hai haan',
]);

/**
 * Lowercase, trim, and strip trailing/leading punctuation so "Haan!" and
 * "haan." both match "haan" — but doesn't touch internal whitespace, so
 * multi-word keywords like "theek hai" still require an exact phrase match.
 */
function normalize(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/^[!.,?\s]+|[!.,?\s]+$/g, '');
}

function isApprovalReply(text) {
  return APPROVAL_KEYWORDS.has(normalize(text));
}

module.exports = { isApprovalReply, APPROVAL_KEYWORDS };
