// src/utils/fixedReplies.js
//
// Replies the WhatsApp assistant sends WITHOUT trusting the model's wording,
// for the cases QA kept catching the model getting wrong (21 Oct list):
//   - a discount question got the whole plan list, even with a 280-char cap
//     (one long sentence had no sentence end to cut at)
//   - an owner (visitor) wanting to sell was told how to "start a listing"
//   - "payment ho gaya, plan activate nahi hua" got a weak or no confirmation
//   - a Roman-script question got a Gurmukhi answer because the earlier chat
//     was in Gurmukhi
// Everything here is pure and unit-tested. Script = 'roman' | 'gurmukhi' |
// 'devanagari' (replyLanguage.detectScript); lang = 'en' | 'hi'.

const GURMUKHI = /[਀-੿]/;
// Devanagari letters only: the danda (। U+0964, ॥ U+0965) is used in Gurmukhi too.
const DEVANAGARI = /[ऀ-ॣ०-ॿ]/;

/** True when the reply is written in the same script as the person's message. */
function replyMatchesScript(reply, script) {
  const r = String(reply || '');
  const g = GURMUKHI.test(r);
  const d = DEVANAGARI.test(r);
  if (script === 'gurmukhi') return g && !d;
  if (script === 'devanagari') return d && !g;
  return !g && !d; // roman (Hinglish or English)
}

// Which of the three fixed-text variants to use: the script wins; Roman text
// is English or Hinglish by lang.
function variant(script, lang) {
  if (script === 'gurmukhi') return 'pa';
  if (script === 'devanagari') return 'hi_deva';
  return lang === 'en' ? 'en' : 'hi';
}

// ------------------------------------------------------------- discount

// Discount/offer words. "trial" is deliberately NOT here: a trial question is
// answered by the model (from OFFERS) and only hard-capped.
const DISCOUNT_WORDS = /(?:discount|disc\b|offer|coupon|chhoot|chhut|chut\b|sasta|kam\s*(?:karo|kar\s*do|ho\s*sakta)|ਡਿਸਕਾਊਂਟ|ਡਿਸਕਾਉਂਟ|ਛੋਟ|ਆਫਰ|ਆਫ਼ਰ|डिस्काउंट|छूट|ऑफर)/i;
const STRONG_PROBLEM = /(?:problem|issue|complaint|shikayat|refund|not\s*working|nahi\s*chal|payment|ਪੇਮੈਂਟ|पेमेंट)/i;

/**
 * A short message that is only a discount/offer question ("Discount?",
 * "koi offer hai?", "ਛੋਟ ਮਿਲੇਗੀ?"). Longer messages that also ask something
 * else go to the model and are hard-capped instead.
 */
function isShortDiscountQuestion(text) {
  const t = String(text || '').trim();
  if (!t || !DISCOUNT_WORDS.test(t) || STRONG_PROBLEM.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length <= 8;
}

/**
 * The fixed 2-line discount answer, built from the live `plans` rows
 * ({ discount_percent }) so it never quotes a stale number.
 */
function discountSummary(plans, { script = 'roman', lang = 'hi' } = {}) {
  const ds = [...new Set((plans || []).map((p) => Number(p.discount_percent) || 0).filter((d) => d > 0))].sort((a, b) => a - b);
  const v = variant(script, lang);
  const min = ds[0]; const max = ds[ds.length - 1];
  const line1 = {
    en: !ds.length ? 'There is no extra discount right now. Prices include GST.'
      : ds.length === 1 ? `Right now every plan is ${min}% off. Prices include GST.`
        : `Right now plans are ${min}% to ${max}% off. Prices include GST.`,
    hi: !ds.length ? 'Abhi koi alag discount nahi hai. Price GST ke saath hai.'
      : ds.length === 1 ? `Abhi sabhi plans pe ${min}% off hai. Price GST ke saath hai.`
        : `Abhi plans pe ${min}% se ${max}% tak off hai. Price GST ke saath hai.`,
    pa: !ds.length ? 'ਇਸ ਵੇਲੇ ਕੋਈ ਵੱਖਰੀ ਛੋਟ ਨਹੀਂ ਹੈ। ਕੀਮਤ GST ਸਮੇਤ ਹੈ।'
      : ds.length === 1 ? `ਇਸ ਵੇਲੇ ਸਾਰੇ ਪਲਾਨਾਂ 'ਤੇ ${min}% ਛੋਟ ਹੈ। ਕੀਮਤ GST ਸਮੇਤ ਹੈ।`
        : `ਇਸ ਵੇਲੇ ਪਲਾਨਾਂ 'ਤੇ ${min}% ਤੋਂ ${max}% ਤੱਕ ਛੋਟ ਹੈ। ਕੀਮਤ GST ਸਮੇਤ ਹੈ।`,
    hi_deva: !ds.length ? 'अभी कोई अलग छूट नहीं है। कीमत GST सहित है।'
      : ds.length === 1 ? `अभी सभी प्लान पर ${min}% छूट है। कीमत GST सहित है।`
        : `अभी प्लान पर ${min}% से ${max}% तक छूट है। कीमत GST सहित है।`,
  }[v];
  const line2 = {
    en: 'Same price for everyone. Type *plan* for the full list.',
    hi: 'Sabke liye same price hai. Poori list ke liye *plan* likhein.',
    pa: 'ਕੀਮਤ ਸਭ ਲਈ ਇੱਕੋ ਹੈ। ਪੂਰੀ ਲਿਸਟ ਲਈ *plan* ਲਿਖੋ।',
    hi_deva: 'कीमत सबके लिए एक जैसी है। पूरी लिस्ट के लिए *plan* लिखें।',
  }[v];
  return `${line1}\n${line2}`;
}

/**
 * Hard cap for replies that must stay short (discount/offer/trial questions
 * that went to the model): at most `maxLines` non-empty lines and `maxChars`
 * characters, cut at a sentence end when one exists, otherwise at a word.
 * Works on one long sentence too (the old cap needed a sentence end).
 */
function hardCapReply(reply, { maxLines = 2, maxChars = 250 } = {}) {
  const lines = String(reply || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, maxLines);
  let out = lines.join('\n');
  if (out.length <= maxChars) return out;
  const head = out.slice(0, maxChars);
  const ends = ['. ', '। ', '! ', '? ', '\n'].map((e) => head.lastIndexOf(e));
  const cut = Math.max(...ends);
  if (cut >= 60) return head.slice(0, cut + 1).trim();
  out = head.replace(/\s+\S*$/, '').replace(/[,;:\-–—\s]+$/, '');
  return `${out}…`;
}

// ------------------------------------------------------------- payment

/** Fixed confirmation when a payment was made but the plan isn't active. */
function paymentProblemReply({ script = 'roman', lang = 'hi' } = {}) {
  return {
    en: '🙏 Noted. I have informed the Plotraa team about your payment. They will contact you on this number shortly.',
    hi: '🙏 Samajh gaya. Team ko bata diya hai, wo jaldi aapse isi number pe contact karegi.',
    pa: '🙏 ਸਮਝ ਗਏ। ਟੀਮ ਨੂੰ ਦੱਸ ਦਿੱਤਾ ਹੈ, ਉਹ ਜਲਦੀ ਤੁਹਾਡੇ ਨਾਲ ਇਸੇ ਨੰਬਰ \'ਤੇ ਸੰਪਰਕ ਕਰੇਗੀ।',
    hi_deva: '🙏 समझ गया। टीम को बता दिया है, वो जल्दी आपसे इसी नंबर पर संपर्क करेगी।',
  }[variant(script, lang)];
}

/** One line added to any reply that raised a support request, unless it already says so. */
function supportConfirmLine({ script = 'roman', lang = 'hi' } = {}) {
  return {
    en: '✅ I have informed the team, they will contact you soon.',
    hi: '✅ Team ko bata diya hai, wo jaldi contact karegi.',
    pa: '✅ ਟੀਮ ਨੂੰ ਦੱਸ ਦਿੱਤਾ ਹੈ, ਉਹ ਜਲਦੀ ਸੰਪਰਕ ਕਰੇਗੀ।',
    hi_deva: '✅ टीम को बता दिया है, वो जल्दी संपर्क करेगी।',
  }[variant(script, lang)];
}

/** Does the reply already tell the person the team will contact them? */
function mentionsTeamContact(reply) {
  const r = String(reply || '');
  return /(?:team|टीम|ਟੀਮ)/i.test(r) && /(?:contact|sampark|call|संपर्क|ਸੰਪਰਕ|कॉल|ਕਾਲ)/i.test(r);
}

// ------------------------------------------------------------- seller (owner)

/**
 * Fixed reply to a property owner on the Plotraa number. An owner never gets
 * a listing of their own, so this never talks about starting a listing: a
 * verified dealer is assigned and contacts them. `seller` = the details saved
 * on the lead so far ({ property_type, city, locality, expected_price }).
 */
function sellerConfirmReply(seller, { script = 'roman', lang = 'hi', sellLink } = {}) {
  const s = seller || {};
  const hasPlace = Boolean(s.city || s.locality);
  const hasAny = Boolean(s.property_type || hasPlace || s.expected_price);
  const v = variant(script, lang);
  const missing = [];
  if (!s.property_type) missing.push({ en: 'property type', hi: 'property type', pa: 'ਪ੍ਰਾਪਰਟੀ ਦੀ ਕਿਸਮ', hi_deva: 'प्रॉपर्टी का टाइप' }[v]);
  if (!hasPlace) missing.push({ en: 'area/city', hi: 'area/city', pa: 'ਏਰੀਆ/ਸ਼ਹਿਰ', hi_deva: 'एरिया/शहर' }[v]);
  if (!s.expected_price) missing.push({ en: 'expected price', hi: 'expected price', pa: 'ਉਮੀਦ ਕੀਤੀ ਕੀਮਤ', hi_deva: 'उम्मीद की कीमत' }[v]);
  const list = missing.join(', ');

  const first = hasAny
    ? {
        en: '🙏 Got your details. A verified dealer will contact you on this number.',
        hi: '🙏 Details mil gayi. Ek verified dealer aapse isi number pe contact karega.',
        pa: '🙏 ਵੇਰਵੇ ਮਿਲ ਗਏ। ਇੱਕ ਵੈਰੀਫਾਈਡ ਡੀਲਰ ਤੁਹਾਡੇ ਨਾਲ ਇਸੇ ਨੰਬਰ \'ਤੇ ਸੰਪਰਕ ਕਰੇਗਾ।',
        hi_deva: '🙏 डिटेल्स मिल गईं। एक वेरिफाइड डीलर आपसे इसी नंबर पर संपर्क करेगा।',
      }[v]
    : {
        en: '🙏 Thank you. A verified dealer will contact you on this number about selling your property.',
        hi: '🙏 Dhanyavaad. Ek verified dealer aapse isi number pe property bechne ke liye contact karega.',
        pa: '🙏 ਧੰਨਵਾਦ। ਇੱਕ ਵੈਰੀਫਾਈਡ ਡੀਲਰ ਪ੍ਰਾਪਰਟੀ ਵੇਚਣ ਲਈ ਤੁਹਾਡੇ ਨਾਲ ਇਸੇ ਨੰਬਰ \'ਤੇ ਸੰਪਰਕ ਕਰੇਗਾ।',
        hi_deva: '🙏 धन्यवाद। एक वेरिफाइड डीलर प्रॉपर्टी बेचने के लिए आपसे इसी नंबर पर संपर्क करेगा।',
      }[v];
  const ask = missing.length
    ? {
        en: `If you can, also send the ${list}.`,
        hi: `Ho sake to ${list} bhi bata dijiye.`,
        pa: `ਹੋ ਸਕੇ ਤਾਂ ${list} ਵੀ ਦੱਸ ਦਿਓ।`,
        hi_deva: `हो सके तो ${list} भी बता दीजिए।`,
      }[v]
    : null;
  const link = sellLink
    ? {
        en: `🌐 You can also add the details here: ${sellLink}`,
        hi: `🌐 Details yahan bhi daal sakte hain: ${sellLink}`,
        pa: `🌐 ਵੇਰਵੇ ਇੱਥੇ ਵੀ ਪਾ ਸਕਦੇ ਹੋ: ${sellLink}`,
        hi_deva: `🌐 डिटेल्स यहाँ भी डाल सकते हैं: ${sellLink}`,
      }[v]
    : null;
  return [first, ask, link].filter(Boolean).join('\n');
}

module.exports = {
  replyMatchesScript,
  isShortDiscountQuestion,
  discountSummary,
  hardCapReply,
  paymentProblemReply,
  supportConfirmLine,
  mentionsTeamContact,
  sellerConfirmReply,
};
