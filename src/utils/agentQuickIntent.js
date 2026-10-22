// src/utils/agentQuickIntent.js
//
// Deterministic pre-check for an agent's WhatsApp text, run BEFORE the AI
// intent classifier in agentIntentService.js. The classifier is told to lean
// towards "listing_info" while a listing draft is open, so with an old
// unfinished draft:
//   - a plain address ("Main Market, Ram Nagar, Ludhiana, Punjab 141003")
//     was answered with the last support reply, and
//   - real questions ("support number?", "plan upgrade", "dashboard login",
//     "payment ho gaya par plan activate nahi hua") were pushed into listing
//     intake and got no useful answer.
// These rules settle the clear cases without the model; anything else returns
// null and goes to the classifier as before.

const LISTING_SIGNAL = /\b\d+(?:\.\d+)?\s*(?:lakh|lac|crore|cr|marla|kanal|gaj|bhk|sq\.?\s*ft|sqft|sq\s*yd)\b/i;
const PINCODE = /(?:^|[^\d])[1-9]\d{5}(?:[^\d]|$)/;
const QUESTION_WORD = /\?|\b(?:kya|kyun|kyu|kaise|kaha|kahan|kitna|kitne|kitni|kab|kaun|how|what|why|where|when|which|can|do|does|is|are|please|plz)\b|ਕੀ|ਕਿਉਂ|ਕਿਵੇਂ|ਕਿੱਥੇ|ਕਿੰਨ|ਕਦੋਂ|कैसे|क्या|क्यों|कहाँ|कितना/i;

// Payment made but the plan is not active: a problem for the team, not a
// receipt-upload prompt (that flow only matches the bare words "payment"/"receipt").
const PAYMENT_PAID = /(?:payment|paid|pay|paisa|paise|bhugtan|pemant|pement|ਪੇਮੈਂਟ|ਭੁਗਤਾਨ|ਪੈਸੇ|पेमेंट|भुगतान|पैसे)/i;
const NOT_ACTIVE = /(?:activate|activated|active|chalu|start|approve|approved|confirm|show|dikh|nahi|nhi|nahin|not|ਨਹੀਂ|ਨਹੀ|ਐਕਟਿਵ|चालू|नहीं|एक्टिव)/i;
const PAYMENT_DONE = /(?:ho\s*gaya|ho\s*gya|kar\s*di|kar\s*diya|kr\s*di|done|made|completed|ਹੋ\s*ਗਿਆ|ਕਰ\s*ਦਿੱਤੀ|हो\s*गया|कर\s*दी)/i;

const QUESTION_TOPICS = [
  // support / contact number
  /(?:support|helpline|customer\s*care|care\s*number|contact\s*(?:no|number)|team\s*(?:ka|ki)?\s*(?:number|no)|ਸਪੋਰਟ|ਹੈਲਪਲਾਈਨ|सपोर्ट|हेल्पलाइन)/i,
  // plan upgrade / change
  /(?:upgrade|downgrade|plan\s*(?:badal|change|badalna|badlo|badhao)|change\s*(?:my\s*)?plan|ਅਪਗ੍ਰੇਡ|ਪਲਾਨ\s*(?:ਬਦਲ|ਚੇਂਜ)|अपग्रेड|प्लान\s*(?:बदल|चेंज))/i,
  // dashboard / login / password
  /(?:dashboard|login|log\s*in|password|web\s*(?:site|panel)|ਡੈਸ਼ਬੋਰਡ|ਲੌਗਿਨ|ਲਾਗਇਨ|ਪਾਸਵਰਡ|डैशबोर्ड|लॉगिन|पासवर्ड)/i,
  // voice notes
  /(?:voice\s*(?:note|message)|audio|bol\s*(?:ke|kar)|ਵੌਇਸ|ਵਾਇਸ|ਬੋਲ\s*ਕੇ|वॉइस|बोल\s*कर)/i,
  // discounts / offers
  /(?:discount|offer|coupon|trial|chhoot|chhut|sasta|ਡਿਸਕਾਊਂਟ|ਡਿਸਕਾਉਂਟ|ਛੋਟ|ਆਫਰ|ਆਫ਼ਰ|डिस्काउंट|छूट|ऑफर)/i,
];

// "plan", "mera plan", "plans list", "trial kab tak hai?": the live plan list /
// the dealer's own plan and trial end date, answered by the system (not the
// model) so the numbers always come from the plans table.
const PLAN_INFO_EXACT = /^(?:my\s*|mera\s*|mere\s*)?(?:plans?|plan\s*list|plans\s*list|plan\s*dikhao|plan\s*batao|plan\s*status|trial(?:\s*status)?|ਪਲਾਨ|ਪਲਾਨ\s*ਦਿਖਾਓ|प्लान|प्लान\s*दिखाओ)[\s?!.]*$/i;
const TRIAL_QUESTION = /\btrial\b[^.?!]*\b(?:kab|kitne|kitna|end|ends|khatam|status|tak|left|baaki|bacha|remaining)\b|\b(?:kab|kitne)\b[^.?!]*\btrial\b/i;

function looksLikePlanInfoRequest(text) {
  const t = String(text || '').trim();
  if (!t || LISTING_SIGNAL.test(t)) return false;
  return PLAN_INFO_EXACT.test(t) || TRIAL_QUESTION.test(t);
}

function normalize(text) {
  return String(text || '').trim();
}

/** A plain address: has a pincode, or several comma-separated parts and no question. */
function looksLikeAddress(text) {
  const t = normalize(text);
  if (!t || t.length > 300) return false;
  if (/\?/.test(t)) return false;
  if (PINCODE.test(t)) return true;
  const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 && !QUESTION_WORD.test(t);
}

function looksLikePaymentProblem(text) {
  const t = normalize(text);
  return PAYMENT_PAID.test(t) && NOT_ACTIVE.test(t) && (PAYMENT_DONE.test(t) || /(?:plan|ਪਲਾਨ|प्लान)/i.test(t));
}

function looksLikeKnownQuestion(text) {
  const t = normalize(text);
  if (!t || LISTING_SIGNAL.test(t)) return false;
  return QUESTION_TOPICS.some((re) => re.test(t));
}

/**
 * Returns 'listing_info' (send to intake), 'support' (payment problem),
 * 'plan_info' (plan list / own plan / trial date), 'question' (answered by
 * the assistant) or null (let the classifier decide).
 * `draftOpen` is true while the agent has an unfinished listing draft.
 */
function quickAgentIntent(text, { draftOpen = false } = {}) {
  const t = normalize(text);
  if (!t) return null;
  if (looksLikeAddress(t)) return 'listing_info';
  if (looksLikePaymentProblem(t)) return 'support';
  if (looksLikePlanInfoRequest(t)) return 'plan_info';
  if (looksLikeKnownQuestion(t)) return 'question';
  void draftOpen;
  return null;
}

module.exports = { quickAgentIntent, looksLikeAddress, looksLikePaymentProblem, looksLikeKnownQuestion, looksLikePlanInfoRequest };
