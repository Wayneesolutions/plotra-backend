// src/utils/visitorFlowParsers.js
//
// Pure text helpers for the WhatsApp role flow (src/services/visitorFlowService.js):
// which role someone picked or stated, and the answers to the step questions
// (type, size, price, area). No database, no model: everything here is
// unit-tested in test/visitorFlow.test.js.

const { looksLikeSellerIntent } = require('./sellerIntent');
const { looksLikeKnownQuestion } = require('./agentQuickIntent');

// ------------------------------------------------------------------ roles

// A person saying outright that they are a dealer / want to join. Used both to
// start the dealer flow and to let someone who was tagged as an owner (or
// anything else) switch to dealer: "join", "main dealer hoon", "judna hai".
const DEALER_PATTERNS = [
  /\bjoin\s+as\s+(?:an?\s+)?(?:agent|dealer|broker)\b/i,
  /\bbecome\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\bsign\s*(?:me\s*)?up\b/i,
  /\bi\s+want\s+to\s+(?:be|become)\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\badd\s+(?:me\s+)?as\s+(?:an?\s+)?(?:agent|dealer)\b/i,
  /\bregister\b/i,
  /\bnaya\s+agent\b/i,
  /\bagent\s+(?:banna|banana|mein\s+add|me\s+add)\b/i,
  /\bdealer\s+banna\b/i,
  /\bmujhe\s+agent\b/i,
  /^\s*(?:i\s+(?:want|wish)\s+to\s+)?join(?:\s+(?:plotraa|plotra|karna|karni|karo|kar\s*do|krna|now|us|please|plz))*\s*[.!?]*\s*$/i,
  /\bjoin\s+(?:karna|karni|karo|kar\s*do|krna|karna\s+hai|karni\s+hai)\b/i,
  /\bjud(?:na|ne|ni|nu)\b/i,
  /\bjudein\b/i,
  /\b(?:main|mai|mein|me|hum|i\s*am|i'm|we\s+are|we're)\s+(?:ek\s+)?(?:property\s+|real\s*estate\s+)?(?:dealer|agent|broker|builder)\b/i,
  /\b(?:dealer|agent|broker)\s+(?:hoon|hun|hu|hain)\b/i,
  /ਡੀਲਰ\s*(?:ਹਾਂ|ਹਾਂਜੀ)|ਜੁੜ(?:ਨਾ|ਣਾ|ਨੇ|ਣੇ)/,
  /डीलर\s*(?:हूँ|हूं|है)|जुड़(?:ना|ने)/,
];

const OWNER_PATTERNS = [
  /\b(?:main|mai|mein|me|i\s*am|i'm)\s+(?:ek\s+)?(?:property\s+)?(?:owner|malik)\b/i,
  /\b(?:owner|malik)\s+(?:hoon|hun|hu)\b/i,
  /^\s*sell\s*[.!?]*\s*$/i,
];

const BUYER_PATTERNS = [
  /\b(?:main|mai|mein|me|i\s*am|i'm)\s+(?:ek\s+)?(?:a\s+)?buyer\b/i,
  /\bbuyer\s+(?:hoon|hun|hu)\b/i,
  /^\s*(?:search|buy)\s*[.!?]*\s*$/i,
];

function isExplicitDealerIntent(text) {
  const t = String(text || '');
  return DEALER_PATTERNS.some((re) => re.test(t));
}

/**
 * The role a person states outright, or null when they only imply one. A
 * dealer statement wins ("main dealer hoon, join karna hai"); a selling verb
 * ("plot bechna hai") is an owner. A plain "plots in Dugri" is NOT explicit:
 * dealers search too, so the bot asks instead of guessing.
 */
function explicitRole(text) {
  const t = String(text || '');
  if (isExplicitDealerIntent(t)) return 'dealer';
  if (looksLikeSellerIntent(t) || OWNER_PATTERNS.some((re) => re.test(t))) return 'owner';
  if (BUYER_PATTERNS.some((re) => re.test(t))) return 'buyer';
  return null;
}

/** "1" / "buyer" / "owner" / "dealer" (also Hindi words) -> role, for the role menu. */
function parseRoleChoice(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?\s]+$/g, '');
  const digit = t.replace(/[️⃣\s.)]/g, '');
  if (['1', '१', '੧'].includes(digit)) return 'buyer';
  if (['2', '२', '੨'].includes(digit)) return 'owner';
  if (['3', '३', '੩'].includes(digit)) return 'dealer';
  if (/^(?:buyer|kharidar|kharidne|khareedar|ਖਰੀਦਦਾਰ|खरीदार|buy|buyer hoon)$/i.test(t)) return 'buyer';
  if (/^(?:owner|malik|maalik|seller|ਮਾਲਕ|मालिक|property owner)$/i.test(t)) return 'owner';
  if (/^(?:dealer|agent|broker|ਡੀਲਰ|डीलर)$/i.test(t)) return 'dealer';
  return null;
}

// ---------------------------------------------------------------- commands

function isMenuCommand(text) {
  return /^\s*(?:menu|role|roles|role\s+(?:badlo|badlna|badal|change)|change\s+role|restart|start\s*over|shuru|main\s*menu|ਮੀਨੂ|मेन्यू)\s*[.!?]*\s*$/i.test(String(text || ''));
}

function isSkip(text) {
  return /^\s*(?:skip|pata\s*nahi|pata\s*nhi|nahi\s*pata|not\s*sure|later|baad\s*mein|chhodo|ਛੱਡੋ|छोड़ो|नहीं\s*पता|ਪਤਾ\s*ਨਹੀਂ)\s*[.!?]*\s*$/i.test(String(text || ''));
}

function isDone(text) {
  return /^\s*(?:done|ho\s*gaya|ho\s*gya|bas|finish|finished|complete|ok\s*done|ਹੋ\s*ਗਿਆ|हो\s*गया)\s*[.!?]*\s*$/i.test(String(text || ''));
}

function isGreeting(text) {
  return /^\s*(?:hi+|hello+|hey+|hlo|helo|namaste|namaskar|sat\s*sri\s*akal|sasriakal|ssa|ram\s*ram|radhe\s*radhe|jai\s*(?:shree\s*)?(?:ram|krishna)|good\s*(?:morning|afternoon|evening|night)|thanks?(?:\s*you)?|thank\s*you|dhanyavaad|dhanyawad|shukriya|ok(?:ay)?|theek\s*hai|thik\s*hai|ਸਤ\s*ਸ੍ਰੀ\s*ਅਕਾਲ|ਸਤਿ\s*ਸ੍ਰੀ\s*ਅਕਾਲ|ਹੈਲੋ|ਧੰਨਵਾਦ|नमस्ते|नमस्कार|हैलो|धन्यवाद)[\s!.,🙏👋😊]*$/i.test(String(text || ''));
}

/** "plan", "plans list", "plan kya hai", "price list": show the live plan list. */
function isPlanListRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return false;
  return /^(?:(?:the\s+|your\s+|aapke\s+|apne\s+|plotraa\s+|plotra\s+)?(?:plans?|packages?|pricing|price\s*list|rates?|charges)(?:\s*(?:list|kya\s*(?:hai|hain)|kitne\s*ka|kitna|batao|dikhao|bhejo|details?|please|plz))*|(?:plan|plans)\s*\??|ਪਲਾਨ|प्लान)[\s?!.]*$/i.test(t);
}

/** Mentions yearly/annual billing: the plans only have monthly prices. */
function mentionsYearly(text) {
  return /\b(?:year(?:ly)?|annual(?:ly)?|saalana|salana|saal\s*(?:ka|ke|bhar)|12\s*months?|barah\s*mahine)\b|ਸਾਲਾਨਾ|ਸਾਲ\s*ਦਾ|सालाना|साल\s*का/i.test(String(text || ''));
}

/** A question or an enquiry, not an answer to the step question. */
function looksLikeQuestion(text) {
  const t = String(text || '');
  if (/\?/.test(t)) return true;
  if (looksLikeKnownQuestion(t)) return true;
  return /\b(?:kya|kaise|kyun|kyu|kitna|kitne|kab|kahan|kaun|how|what|why|when|which|plan|price|pricing|charges?|fees?|trial|discount|offer|yearly|annual|refund|support|help)\b/i.test(t)
    && t.split(/\s+/).length >= 2;
}

// ------------------------------------------------------------ step answers

const TYPE_MENU = { 1: 'Plot', 2: 'Villa', 3: 'Flat', 4: 'Commercial', 5: 'Plot' };
const TYPE_WORDS = [
  [/\b(kothi|villa|house|makaan|makan|ghar|bungalow|ਕੋਠੀ|ਮਕਾਨ|ਘਰ|कोठी|मकान|घर)\b|ਕੋਠੀ|कोठी/i, 'Villa'],
  [/\b(flat|apartment|floor|builder\s*floor|ਫਲੈਟ|फ्लैट)\b|ਫਲੈਟ|फ्लैट/i, 'Flat'],
  [/\b(shop|showroom|dukaan|dukan|office|sco|commercial|booth|ਦੁਕਾਨ|दुकान)\b|ਦੁਕਾਨ|दुकान/i, 'Commercial'],
  [/\b(plot|zameen|jameen|land|khet|kheti|agricultural|ਪਲਾਟ|ਜ਼ਮੀਨ|ਜਮੀਨ|प्लॉट|ज़मीन|जमीन)\b|ਪਲਾਟ|ਜ਼ਮੀਨ|प्लॉट|ज़मीन/i, 'Plot'],
];

/** Property type from a menu number or words ("2", "kothi", "dukaan"). Returns 'Plot'|'Villa'|'Flat'|'Commercial'|null. */
function parsePropertyType(text, { allowMenuNumber = true } = {}) {
  const t = String(text || '').trim();
  const num = t.replace(/[️⃣\s.)]/g, '');
  if (allowMenuNumber && /^[1-5]$/.test(num)) return TYPE_MENU[num];
  const hit = TYPE_WORDS.find(([re]) => re.test(t));
  return hit ? hit[1] : null;
}

const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(gaj|gaz|gajj|marla|marle|kanal|kanaal|bigha|acre|sq\.?\s*ft|sqft|square\s*feet|sq\.?\s*y(?:ar)?d?s?|yards?|bhk|ਗਜ|ਮਰਲੇ|ਮਰਲਾ|ਕਨਾਲ|गज|मरला|कनाल)/i;

/** "200 gaj", "10 marla", "3 BHK" from the text, or null. */
function parseSize(text) {
  const m = String(text || '').match(SIZE_RE);
  return m ? `${m[1].replace(',', '.')} ${m[2].replace(/\s+/g, ' ').toLowerCase()}`.replace(/\bbhk\b/, 'BHK') : null;
}

const PRICE_RE = /(?:₹|rs\.?|inr)?\s*(\d+(?:[.,]\d+)?)\s*(crore|crores|cr|karod|lakh|lakhs|lac|lacs|k|thousand|हज़ार|लाख|करोड़|ਲੱਖ|ਕਰੋੜ)\b/i;
const UNIT_INR = { crore: 1e7, crores: 1e7, cr: 1e7, karod: 1e7, 'करोड़': 1e7, 'ਕਰੋੜ': 1e7, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, 'लाख': 1e5, 'ਲੱਖ': 1e5, k: 1e3, thousand: 1e3, 'हज़ार': 1e3 };

/** "80 lakh" / "1.5 crore" -> { text: '80 lakh', inr: 8000000 } or null. A bare big number is rupees. */
function parsePrice(text) {
  const t = String(text || '');
  const m = t.match(PRICE_RE);
  if (m) {
    const value = Number(m[1].replace(',', '.'));
    const unit = UNIT_INR[m[2].toLowerCase()] || UNIT_INR[m[2]];
    if (Number.isFinite(value) && unit) return { text: `${m[1]} ${m[2].toLowerCase()}`, inr: Math.round(value * unit) };
  }
  const bare = t.replace(/[,\s₹]/g, '').match(/^(?:rs\.?|inr)?(\d{6,10})$/i);
  if (bare) return { text: `₹${Number(bare[1]).toLocaleString('en-IN')}`, inr: Number(bare[1]) };
  return null;
}

/** "Dugri, Ludhiana" -> { locality: 'Dugri', city: 'Ludhiana' }; a lone known city is a city. */
function splitLocation(text, knownCities = []) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { locality: null, city: null };
  const parts = clean.split(/\s*,\s*/).filter(Boolean);
  if (parts.length >= 2) return { locality: parts.slice(0, -1).join(', ').slice(0, 255), city: parts[parts.length - 1].slice(0, 100) };
  const known = new Set(knownCities.map((c) => String(c).toLowerCase()));
  if (known.has(clean.toLowerCase())) return { locality: null, city: clean.slice(0, 100) };
  return { locality: clean.slice(0, 255), city: null };
}

/** A believable personal / business name: 2-60 chars, mostly letters, not a question or a command. */
function looksLikeName(text) {
  const t = String(text || '').trim();
  if (t.length < 2 || t.length > 60) return false;
  if (/\?/.test(t) || isMenuCommand(t) || isGreeting(t) || isSkip(t)) return false;
  const letters = (t.match(/[A-Za-zऀ-ॿ਀-੿]/g) || []).length;
  if (letters < 2 || letters / t.length < 0.6) return false;
  return t.split(/\s+/).length <= 6;
}

module.exports = {
  isExplicitDealerIntent,
  explicitRole,
  parseRoleChoice,
  isMenuCommand,
  isSkip,
  isDone,
  isGreeting,
  isPlanListRequest,
  mentionsYearly,
  looksLikeQuestion,
  parsePropertyType,
  parseSize,
  parsePrice,
  splitLocation,
  looksLikeName,
  TYPE_MENU,
};
