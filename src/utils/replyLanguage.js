// src/utils/replyLanguage.js
//
// The web chat's replies were hardcoded Hindi/Hinglish regardless of what
// language the realtor actually typed in — fine for the majority who do
// write in Hinglish, but wrong for anyone typing in plain English, and
// there was no English fallback at all. This is a cheap heuristic, not a
// real language classifier: check for Devanagari/Gurmukhi script first
// (unambiguous), then fall back to counting common romanized Hindi/Punjabi
// marker words against total word count. Defaults to English when
// genuinely unclear — matching "at least English should be there" rather
// than silently guessing Hindi.

const DEVANAGARI_OR_GURMUKHI = /[\u0900-\u097F\u0A00-\u0A7F]/;

// Common romanized Hindi/Punjabi words that show up in Hinglish real-estate
// chat but essentially never appear in plain English sentences. Not
// exhaustive — this only needs to catch the common case, not every case.
const HINGLISH_MARKERS = new Set([
  'hai', 'hain', 'ho', 'hoga', 'hogi', 'kya', 'kyu', 'kyun', 'kitna', 'kitni',
  'chahiye', 'sahi', 'thik', 'theek', 'haan', 'ha', 'nahi', 'nahin', 'lakh',
  'crore', 'gaj', 'marla', 'kanal', 'wala', 'wali', 'karo', 'karlo', 'kardo',
  'dijiye', 'dena', 'batao', 'bata', 'bhej', 'bhejo', 'accha', 'achha',
  'bahut', 'zyada', 'thoda', 'abhi', 'yeh', 'ye', 'woh', 'wo', 'mera', 'meri',
  'aapka', 'aapki', 'aap', 'apna', 'plot', 'makan', 'ghar', 'dukaan',
]);

function normalizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Returns 'hi' (Hindi/Hinglish) or 'en' (English). Defaults to 'en' unless
 * there's a reasonably clear signal otherwise.
 */
function detectReplyLanguage(text) {
  if (!text) return 'en';
  if (DEVANAGARI_OR_GURMUKHI.test(text)) return 'hi';

  const words = normalizeWords(text);
  if (words.length === 0) return 'en';

  const markerCount = words.filter((w) => HINGLISH_MARKERS.has(w)).length;
  // Require actual signal, not just one incidental match in a long
  // English sentence — at least ~20% of words, or 2+ marker words outright.
  if (markerCount >= 2 || (words.length <= 5 && markerCount >= 1)) return 'hi';

  return 'en';
}

module.exports = { detectReplyLanguage };
