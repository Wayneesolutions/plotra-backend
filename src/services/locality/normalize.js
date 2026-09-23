/**
 * Turns messy dealer text into a comparable form.
 *   "H.No 123, Dugri Ph-II, near canal, Ldh 141013"
 *   -> "h no 123 dugri phase 2 near canal"   (pincode extracted separately)
 * Keeps Gurmukhi / Devanagari letters and their vowel marks intact.
 */

const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8' };

// Words that never help identify a locality
const CITY_NOISE = new Set(['ludhiana', 'ldh', 'ludh', 'punjab', 'pb', 'india', 'ਲੁਧਿਆਣਾ', 'लुधियाना']);

// Words that mean "the locality after me is only a reference point"
const PROXIMITY_WORDS = new Set([
  'near', 'nr', 'opp', 'opposite', 'behind', 'beside', 'next', 'paas', 'pass', 'kol', 'nearby',
  'ਨੇੜੇ', 'ਕੋਲ', 'पास', 'नजदीक', 'सामने',
]);

function extractPincode(text) {
  const m = String(text || '').match(/\b(1[4-6]\d{4})\b/); // Punjab-ish PIN range 14xxxx-16xxxx
  return m ? m[1] : null;
}

function normalize(text) {
  let s = String(text || '').normalize('NFC').toLowerCase();

  s = s.replace(/\b1[4-6]\d{4}\b/g, ' ');                           // drop pincode
  s = s.replace(/[^\p{L}\p{M}\p{N}\s-]/gu, ' ');                    // punctuation -> space (keep matras)

  // phase: "ph-2", "ph 2", "phase-ii", "ph.ii" -> "phase 2"
  s = s.replace(/\bph(?:ase)?[\s-]*(\d+|viii|vii|vi|iv|v|iii|ii|i)\b/g, (_, n) => `phase ${ROMAN[n] || n}`);
  // sector: "sec-32a", "sector 32 a" -> "sector 32a"
  s = s.replace(/\bsec(?:tor)?[\s-]*(\d+)\s*([a-d])?\b/g, (_, n, l) => `sector ${n}${l || ''}`);
  // block / pocket letters stay as-is; expand common shorthands
  s = s
    .replace(/\bext(?:n|ension)?\b/g, 'extension')
    .replace(/\bngr\b/g, 'nagar')
    .replace(/\brd\b/g, 'road')
    .replace(/\bcol(?:ony)?\b/g, 'colony')
    .replace(/\bchk\b/g, 'chowk')
    .replace(/\bu\s*e\b/g, 'urban estate')
    .replace(/\bkln\b/g, 'kalan')
    .replace(/\bkhd\b/g, 'khurd');

  s = s.replace(/-/g, ' ');
  const tokens = s.split(/\s+/).filter((t) => t && !CITY_NOISE.has(t));
  return tokens.join(' ');
}

function slugify(name) {
  return normalize(name).replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
}

module.exports = { normalize, extractPincode, slugify, PROXIMITY_WORDS };
