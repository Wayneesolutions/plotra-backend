// src/utils/sellerIntent.js
//
// An owner telling Plotraa they want to SELL their own property ("meri Dugri
// wali kothi bechni hai 1.5 crore") reads like a buyer search to the search
// extractor (it sees area + type + price), so they used to get a list of
// other people's listings instead of a seller lead. This is a cheap,
// conservative first-person check run BEFORE the buyer search and as a
// safety net after the assistant's reply. It matches selling verbs in
// Hinglish, Punjabi, Hindi and English that a buyer would not say about
// their own property; "for sale" alone is deliberately NOT a match
// ("plots for sale in Dugri" is a buyer search).

const SELLER_PATTERNS = [
  // Hinglish / Punjabi (Roman): bechni / bechna / bechne / bechan / vechni ... hai / chahta / karni
  /\b(?:bech|vech|bikh?)(?:ni|na|ne|nu|an|ana|wana|wani|wane)\b/i,
  /\bbik(?:au|wana|wani|wane)\b/i,
  /\bbech\s*(?:dena|dunga|dungi|denge|raha|rahi|rahe)\b/i,
  // Devanagari / Gurmukhi
  /बेच(?:नी|ना|ने|नु|ना\s*चाह)|बिकाऊ/,
  /ਵੇਚ(?:ਣ|ਣੀ|ਣਾ|ਣੇ)|ਵਿਕਾਊ/,
  // English, first person only
  /\b(?:i|we)\s*(?:want|wish|need|would\s+like|plan|am\s+planning)\s+to\s+sell\b/i,
  /\b(?:i\s*am|i'm|we\s*are|we're)\s+(?:selling|looking\s+to\s+sell)\b/i,
  /\bsell(?:ing)?\s+(?:my|our)\b/i,
  /\bmy\s+(?:\w+\s+){0,3}(?:is|are)\s+for\s+sale\b/i,
  /\bmeri\s+(?:\w+\s+){0,3}(?:for\s+sale|bechni|bechna)\b/i,
];

function looksLikeSellerIntent(text) {
  const t = String(text || '');
  return SELLER_PATTERNS.some((re) => re.test(t));
}

const TYPE_WORDS = [
  [/\b(kothi|villa|house|makaan|makan|ghar|bungalow)\b/i, 'Villa'],
  [/\b(plot|zameen|jameen|land)\b/i, 'Plot'],
  [/\b(flat|apartment|floor)\b/i, 'Flat'],
  [/\b(shop|showroom|dukaan|dukan|office|sco|commercial)\b/i, 'Commercial'],
];

/** Best-effort fields from the text; the model's own reading wins when present. */
function extractSellerHints(text) {
  const t = String(text || '');
  const type = TYPE_WORDS.find(([re]) => re.test(t));
  const price = t.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lac|lakhs|k)\b/i);
  const size = t.match(/(\d+(?:\.\d+)?)\s*(gaj|marla|kanal|sq\.?\s*ft|sqft|sq\s*yard|yard|acre|bigha)\b/i);
  return {
    property_type: type ? type[1] : null,
    expected_price: price ? `${price[1]} ${price[2]}` : null,
    size_text: size ? `${size[1]} ${size[2]}` : null,
  };
}

/**
 * Is this message plausibly MORE DETAILS about a property being sold ("200 gaj",
 * "1.5 crore", "plot Dugri mein")? A greeting, a plan/price question or a
 * "join" is not. 22 Oct bug A: after an owner's first message every later
 * message ("hi", "plan kya hai") got the owner confirmation again because an
 * open seller lead made the assistant treat everything as the sale.
 */
function looksLikeSaleDetails(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (looksLikeSellerIntent(t)) return true;
  const hints = extractSellerHints(t);
  return Boolean(hints.property_type || hints.expected_price || hints.size_text);
}

module.exports = { looksLikeSellerIntent, extractSellerHints, looksLikeSaleDetails };
