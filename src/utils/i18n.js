// src/utils/i18n.js
//
// Fixed WhatsApp texts in the four variants the bot writes in: plain English
// ('en'), Roman-script Hinglish ('hi'), Gurmukhi Punjabi ('pa') and
// Devanagari Hindi ('hi_deva'). A fixed reply must come out in the SAME
// script as the person's latest message (22 Oct bug C: a Gurmukhi message got
// a Roman greeting and plan list). Pick the variant with
//   variant(detectScript(text), detectMessageLanguage(text) || chatLang)
// from fixedReplies.js, or use `variantFor(text, fallbackLang)` below.
//
// Texts live here (not inline in the handlers) so wording is reviewed in one
// place and a unit test can check that every key has all four variants.

const { variant } = require('./fixedReplies');
const { detectScript, detectMessageLanguage, detectReplyLanguage } = require('./replyLanguage');

/** Variant for one message; `chatText` (earlier messages) only breaks a tie. */
function variantFor(text, chatText = '') {
  const script = detectScript(text);
  const lang = detectMessageLanguage(text) || detectReplyLanguage(`${chatText} ${text}`);
  return variant(script, lang);
}

const M = {
  // ------------------------------------------------------------- role menu
  role_menu: {
    en: 'Hello! 👋 Welcome to Plotraa.\n\nFirst, tell me who you are. Just send a number:\n1️⃣ Buyer: I want to buy a property\n2️⃣ Dealer: I want to list properties on Plotraa (7-day free trial)\n\nTo change your role later, type *menu* any time.',
    hi: 'Namaste! 👋 Plotraa mein aapka swagat hai.\n\nPehle bataiye, aap kaun hain? Sirf number bhejein:\n1️⃣ Buyer: property kharidni hai\n2️⃣ Dealer: Plotraa pe listings daalni hain (7 din free trial)\n\nRole badalna ho to kabhi bhi *menu* likhein.',
    pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! 👋 Plotraa ਵਿੱਚ ਤੁਹਾਡਾ ਸੁਆਗਤ ਹੈ।\n\nਪਹਿਲਾਂ ਦੱਸੋ, ਤੁਸੀਂ ਕੌਣ ਹੋ? ਸਿਰਫ਼ ਨੰਬਰ ਭੇਜੋ:\n1️⃣ Buyer: ਪ੍ਰਾਪਰਟੀ ਖਰੀਦਣੀ ਹੈ\n2️⃣ Dealer: Plotraa \'ਤੇ ਲਿਸਟਿੰਗ ਪਾਉਣੀ ਹੈ (7 ਦਿਨ ਮੁਫ਼ਤ ਟ੍ਰਾਇਲ)\n\nਰੋਲ ਬਦਲਣਾ ਹੋਵੇ ਤਾਂ ਕਦੇ ਵੀ *menu* ਲਿਖੋ।',
    hi_deva: 'नमस्ते! 👋 Plotraa में आपका स्वागत है।\n\nपहले बताइए, आप कौन हैं? सिर्फ़ नंबर भेजें:\n1️⃣ Buyer: प्रॉपर्टी खरीदनी है\n2️⃣ Dealer: Plotraa पर लिस्टिंग डालनी है (7 दिन मुफ़्त ट्रायल)\n\nरोल बदलना हो तो कभी भी *menu* लिखें।',
  },
  // 23 Oct: anyone who says they want to SELL gets the sell-property form
  // link (no search, whatever role they are in).
  sell_link: {
    en: '🏡 Want to sell your property? Fill in the details here and a verified local dealer will contact you:\n{url}',
    hi: '🏡 Property bechni hai? Yahan details bhariye, ek verified local dealer aapse contact karega:\n{url}',
    pa: '🏡 ਪ੍ਰਾਪਰਟੀ ਵੇਚਣੀ ਹੈ? ਇੱਥੇ ਵੇਰਵੇ ਭਰੋ, ਇੱਕ ਵੈਰੀਫਾਈਡ ਲੋਕਲ ਡੀਲਰ ਤੁਹਾਡੇ ਨਾਲ ਸੰਪਰਕ ਕਰੇਗਾ:\n{url}',
    hi_deva: '🏡 प्रॉपर्टी बेचनी है? यहाँ डिटेल्स भरिए, एक वेरिफाइड लोकल डीलर आपसे संपर्क करेगा:\n{url}',
  },
  role_retry: {
    en: 'Please reply with 1 or 2:\n1️⃣ Buyer  2️⃣ Dealer',
    hi: 'Kripya 1 ya 2 bhejein:\n1️⃣ Buyer  2️⃣ Dealer',
    pa: 'ਕਿਰਪਾ ਕਰਕੇ 1 ਜਾਂ 2 ਭੇਜੋ:\n1️⃣ Buyer  2️⃣ Dealer',
    hi_deva: 'कृपया 1 या 2 भेजें:\n1️⃣ Buyer  2️⃣ Dealer',
  },
  role_set_buyer: {
    en: '👍 Okay, you are a *Buyer*. Let me ask a few quick questions to find the right property.',
    hi: '👍 Theek hai, aap *Buyer* hain. Sahi property dhundhne ke liye kuch chhote sawaal poochta hoon.',
    pa: '👍 ਠੀਕ ਹੈ, ਤੁਸੀਂ *Buyer* ਹੋ। ਸਹੀ ਪ੍ਰਾਪਰਟੀ ਲੱਭਣ ਲਈ ਕੁਝ ਛੋਟੇ ਸਵਾਲ ਪੁੱਛਦਾ ਹਾਂ।',
    hi_deva: '👍 ठीक है, आप *Buyer* हैं। सही प्रॉपर्टी ढूँढने के लिए कुछ छोटे सवाल पूछता हूँ।',
  },
  role_set_owner: {
    en: '👍 Okay, you are a property *Owner*. I will note down your property details one by one, and a verified dealer will contact you.',
    hi: '👍 Theek hai, aap property *Owner* hain. Main aapki property ki details ek ek karke likhta hoon, phir ek verified dealer aapse contact karega.',
    pa: '👍 ਠੀਕ ਹੈ, ਤੁਸੀਂ ਪ੍ਰਾਪਰਟੀ *Owner* ਹੋ। ਮੈਂ ਤੁਹਾਡੀ ਪ੍ਰਾਪਰਟੀ ਦੇ ਵੇਰਵੇ ਇੱਕ-ਇੱਕ ਕਰਕੇ ਲਿਖਦਾ ਹਾਂ, ਫਿਰ ਇੱਕ ਵੈਰੀਫਾਈਡ ਡੀਲਰ ਤੁਹਾਡੇ ਨਾਲ ਸੰਪਰਕ ਕਰੇਗਾ।',
    hi_deva: '👍 ठीक है, आप प्रॉपर्टी *Owner* हैं। मैं आपकी प्रॉपर्टी की डिटेल्स एक-एक करके लिखता हूँ, फिर एक वेरिफाइड डीलर आपसे संपर्क करेगा।',
  },
  role_set_dealer: {
    en: '👍 Okay, you want to join as a *Dealer*.',
    hi: '👍 Theek hai, aap *Dealer* ke roop mein judna chahte hain.',
    pa: '👍 ਠੀਕ ਹੈ, ਤੁਸੀਂ *Dealer* ਵਜੋਂ ਜੁੜਨਾ ਚਾਹੁੰਦੇ ਹੋ।',
    hi_deva: '👍 ठीक है, आप *Dealer* के रूप में जुड़ना चाहते हैं।',
  },

  // ------------------------------------------------------------- owner flow
  owner_ask_type: {
    en: '🏠 What type of property is it? Send a number:\n1. Plot\n2. Kothi / House\n3. Flat\n4. Commercial (shop, SCO, office)\n5. Agricultural land',
    hi: '🏠 Property kis type ki hai? Number bhejein:\n1. Plot\n2. Kothi / House\n3. Flat\n4. Commercial (shop, SCO, office)\n5. Kheti ki zameen',
    pa: '🏠 ਪ੍ਰਾਪਰਟੀ ਕਿਸ ਕਿਸਮ ਦੀ ਹੈ? ਨੰਬਰ ਭੇਜੋ:\n1. Plot\n2. ਕੋਠੀ / House\n3. Flat\n4. Commercial (ਦੁਕਾਨ, SCO, ਦਫ਼ਤਰ)\n5. ਖੇਤੀ ਦੀ ਜ਼ਮੀਨ',
    hi_deva: '🏠 प्रॉपर्टी किस टाइप की है? नंबर भेजें:\n1. Plot\n2. कोठी / House\n3. Flat\n4. Commercial (दुकान, SCO, ऑफिस)\n5. खेती की ज़मीन',
  },
  owner_ask_size: {
    en: '📐 What is the size? (e.g. 200 gaj, 10 marla, 1 kanal, 1200 sq ft). Send *skip* if you are not sure.',
    hi: '📐 Size kitna hai? (jaise 200 gaj, 10 marla, 1 kanal, 1200 sq ft). Pata na ho to *skip* likhein.',
    pa: '📐 ਸਾਈਜ਼ ਕਿੰਨਾ ਹੈ? (ਜਿਵੇਂ 200 ਗਜ, 10 ਮਰਲੇ, 1 ਕਨਾਲ, 1200 sq ft)। ਪਤਾ ਨਾ ਹੋਵੇ ਤਾਂ *skip* ਲਿਖੋ।',
    hi_deva: '📐 साइज़ कितना है? (जैसे 200 गज, 10 मरला, 1 कनाल, 1200 sq ft)। पता न हो तो *skip* लिखें।',
  },
  owner_ask_location: {
    en: '📍 Where is the property? Send the area and city (e.g. "Dugri, Ludhiana").',
    hi: '📍 Property kahan hai? Area aur city likhein (jaise "Dugri, Ludhiana").',
    pa: '📍 ਪ੍ਰਾਪਰਟੀ ਕਿੱਥੇ ਹੈ? ਏਰੀਆ ਅਤੇ ਸ਼ਹਿਰ ਲਿਖੋ (ਜਿਵੇਂ "ਦੁੱਗਰੀ, ਲੁਧਿਆਣਾ")।',
    hi_deva: '📍 प्रॉपर्टी कहाँ है? एरिया और शहर लिखें (जैसे "दुगरी, लुधियाना")।',
  },
  owner_ask_price: {
    en: '💰 What price do you expect? (e.g. 80 lakh, 1.5 crore). Send *skip* if you want to discuss it with the dealer.',
    hi: '💰 Aap kitni price expect karte hain? (jaise 80 lakh, 1.5 crore). Dealer se baat karni ho to *skip* likhein.',
    pa: '💰 ਤੁਸੀਂ ਕਿੰਨੀ ਕੀਮਤ ਚਾਹੁੰਦੇ ਹੋ? (ਜਿਵੇਂ 80 ਲੱਖ, 1.5 ਕਰੋੜ)। ਡੀਲਰ ਨਾਲ ਗੱਲ ਕਰਨੀ ਹੋਵੇ ਤਾਂ *skip* ਲਿਖੋ।',
    hi_deva: '💰 आप कितनी कीमत चाहते हैं? (जैसे 80 लाख, 1.5 करोड़)। डीलर से बात करनी हो तो *skip* लिखें।',
  },
  owner_ask_photos: {
    en: '📷 Send up to 5 photos of the property here. When done, send *done* (or *skip* if you have no photos).',
    hi: '📷 Property ki 5 tak photos yahin bhejein. Ho jaye to *done* likhein (photos na hon to *skip*).',
    pa: '📷 ਪ੍ਰਾਪਰਟੀ ਦੀਆਂ 5 ਤੱਕ ਫੋਟੋਆਂ ਇੱਥੇ ਭੇਜੋ। ਹੋ ਜਾਵੇ ਤਾਂ *done* ਲਿਖੋ (ਫੋਟੋਆਂ ਨਾ ਹੋਣ ਤਾਂ *skip*)।',
    hi_deva: '📷 प्रॉपर्टी की 5 तक फ़ोटो यहीं भेजें। हो जाए तो *done* लिखें (फ़ोटो न हों तो *skip*)।',
  },
  owner_photo_saved: {
    en: '📷 Photo saved ({n}/5). Send more, or *done* to finish.',
    hi: '📷 Photo save ho gayi ({n}/5). Aur bhejein, ya khatam karne ke liye *done* likhein.',
    pa: '📷 ਫੋਟੋ ਸੇਵ ਹੋ ਗਈ ({n}/5)। ਹੋਰ ਭੇਜੋ, ਜਾਂ ਖ਼ਤਮ ਕਰਨ ਲਈ *done* ਲਿਖੋ।',
    hi_deva: '📷 फ़ोटो सेव हो गई ({n}/5)। और भेजें, या खत्म करने के लिए *done* लिखें।',
  },
  owner_photo_limit: {
    en: '📷 5 photos received, that is the limit. Sending your details now.',
    hi: '📷 5 photos mil gayin, itni hi le sakte hain. Ab details aage bhej raha hoon.',
    pa: '📷 5 ਫੋਟੋਆਂ ਮਿਲ ਗਈਆਂ, ਇੰਨੀਆਂ ਹੀ ਲੈ ਸਕਦੇ ਹਾਂ। ਹੁਣ ਵੇਰਵੇ ਅੱਗੇ ਭੇਜ ਰਿਹਾ ਹਾਂ।',
    hi_deva: '📷 5 फ़ोटो मिल गईं, इतनी ही ले सकते हैं। अब डिटेल्स आगे भेज रहा हूँ।',
  },
  owner_photo_failed: {
    en: 'Sorry, I could not save that photo. Please send it again, or send *done* to continue.',
    hi: 'Maaf kijiye, ye photo save nahi ho payi. Dobara bhejein, ya aage badhne ke liye *done* likhein.',
    pa: 'ਮਾਫ਼ ਕਰਨਾ, ਇਹ ਫੋਟੋ ਸੇਵ ਨਹੀਂ ਹੋ ਸਕੀ। ਦੁਬਾਰਾ ਭੇਜੋ, ਜਾਂ ਅੱਗੇ ਵਧਣ ਲਈ *done* ਲਿਖੋ।',
    hi_deva: 'माफ़ कीजिए, यह फ़ोटो सेव नहीं हो पाई। दोबारा भेजें, या आगे बढ़ने के लिए *done* लिखें।',
  },
  step_retry: {
    en: 'I could not understand that. {prompt}',
    hi: 'Ye samajh nahi aaya. {prompt}',
    pa: 'ਇਹ ਸਮਝ ਨਹੀਂ ਆਇਆ। {prompt}',
    hi_deva: 'यह समझ नहीं आया। {prompt}',
  },
  owner_done: {
    en: '✅ Thank you! Your details are saved:\n{summary}\n\nA verified dealer will contact you on this number. To sell another property, type *sell*. To change role, type *menu*.',
    hi: '✅ Dhanyavaad! Aapki details save ho gayin:\n{summary}\n\nEk verified dealer aapse isi number pe contact karega. Doosri property bechni ho to *sell* likhein. Role badalne ke liye *menu*.',
    pa: '✅ ਧੰਨਵਾਦ! ਤੁਹਾਡੇ ਵੇਰਵੇ ਸੇਵ ਹੋ ਗਏ:\n{summary}\n\nਇੱਕ ਵੈਰੀਫਾਈਡ ਡੀਲਰ ਤੁਹਾਡੇ ਨਾਲ ਇਸੇ ਨੰਬਰ \'ਤੇ ਸੰਪਰਕ ਕਰੇਗਾ। ਹੋਰ ਪ੍ਰਾਪਰਟੀ ਵੇਚਣੀ ਹੋਵੇ ਤਾਂ *sell* ਲਿਖੋ। ਰੋਲ ਬਦਲਣ ਲਈ *menu*।',
    hi_deva: '✅ धन्यवाद! आपकी डिटेल्स सेव हो गईं:\n{summary}\n\nएक वेरिफाइड डीलर आपसे इसी नंबर पर संपर्क करेगा। दूसरी प्रॉपर्टी बेचनी हो तो *sell* लिखें। रोल बदलने के लिए *menu*।',
  },
  owner_after_done: {
    en: '🙏 Your property details are with our team. A verified dealer will contact you on this number. For another property type *sell*, to change role type *menu*.',
    hi: '🙏 Aapki property ki details team ke paas hain. Ek verified dealer aapse isi number pe contact karega. Doosri property ke liye *sell*, role badalne ke liye *menu* likhein.',
    pa: '🙏 ਤੁਹਾਡੀ ਪ੍ਰਾਪਰਟੀ ਦੇ ਵੇਰਵੇ ਸਾਡੀ ਟੀਮ ਕੋਲ ਹਨ। ਇੱਕ ਵੈਰੀਫਾਈਡ ਡੀਲਰ ਤੁਹਾਡੇ ਨਾਲ ਇਸੇ ਨੰਬਰ \'ਤੇ ਸੰਪਰਕ ਕਰੇਗਾ। ਹੋਰ ਪ੍ਰਾਪਰਟੀ ਲਈ *sell*, ਰੋਲ ਬਦਲਣ ਲਈ *menu* ਲਿਖੋ।',
    hi_deva: '🙏 आपकी प्रॉपर्टी की डिटेल्स टीम के पास हैं। एक वेरिफाइड डीलर आपसे इसी नंबर पर संपर्क करेगा। दूसरी प्रॉपर्टी के लिए *sell*, रोल बदलने के लिए *menu* लिखें।',
  },

  // ------------------------------------------------------------- buyer flow
  buyer_ask_budget: {
    en: '💰 What is your budget? (e.g. 50 lakh, 1 crore). Send *skip* if open.',
    hi: '💰 Aapka budget kitna hai? (jaise 50 lakh, 1 crore). Fix na ho to *skip* likhein.',
    pa: '💰 ਤੁਹਾਡਾ ਬਜਟ ਕਿੰਨਾ ਹੈ? (ਜਿਵੇਂ 50 ਲੱਖ, 1 ਕਰੋੜ)। ਪੱਕਾ ਨਾ ਹੋਵੇ ਤਾਂ *skip* ਲਿਖੋ।',
    hi_deva: '💰 आपका बजट कितना है? (जैसे 50 लाख, 1 करोड़)। तय न हो तो *skip* लिखें।',
  },
  buyer_ask_area: {
    en: '📍 Which area or city do you want the property in? (e.g. "Dugri, Ludhiana")',
    hi: '📍 Kis area ya city mein property chahiye? (jaise "Dugri, Ludhiana")',
    pa: '📍 ਕਿਸ ਏਰੀਏ ਜਾਂ ਸ਼ਹਿਰ ਵਿੱਚ ਪ੍ਰਾਪਰਟੀ ਚਾਹੀਦੀ ਹੈ? (ਜਿਵੇਂ "ਦੁੱਗਰੀ, ਲੁਧਿਆਣਾ")',
    hi_deva: '📍 किस एरिया या शहर में प्रॉपर्टी चाहिए? (जैसे "दुगरी, लुधियाना")',
  },
  buyer_ask_type: {
    en: '🏠 What type of property? Send a number:\n1. Plot\n2. Kothi / House\n3. Flat\n4. Commercial (shop, SCO, office)\n5. Agricultural land\n\nWant more than one? Send all the numbers, e.g. *1, 3*',
    hi: '🏠 Kis type ki property chahiye? Number bhejein:\n1. Plot\n2. Kothi / House\n3. Flat\n4. Commercial (shop, SCO, office)\n5. Kheti ki zameen\n\nEk se zyada chahiye to saare number bhejein, jaise *1, 3*',
    pa: '🏠 ਕਿਸ ਕਿਸਮ ਦੀ ਪ੍ਰਾਪਰਟੀ ਚਾਹੀਦੀ ਹੈ? ਨੰਬਰ ਭੇਜੋ:\n1. Plot\n2. ਕੋਠੀ / House\n3. Flat\n4. Commercial (ਦੁਕਾਨ, SCO, ਦਫ਼ਤਰ)\n5. ਖੇਤੀ ਦੀ ਜ਼ਮੀਨ\n\nਇੱਕ ਤੋਂ ਵੱਧ ਚਾਹੀਦੀ ਹੈ ਤਾਂ ਸਾਰੇ ਨੰਬਰ ਭੇਜੋ, ਜਿਵੇਂ *1, 3*',
    hi_deva: '🏠 किस टाइप की प्रॉपर्टी चाहिए? नंबर भेजें:\n1. Plot\n2. कोठी / House\n3. Flat\n4. Commercial (दुकान, SCO, ऑफिस)\n5. खेती की ज़मीन\n\nएक से ज़्यादा चाहिए तो सारे नंबर भेजें, जैसे *1, 3*',
  },
  buyer_ask_size: {
    en: '📐 What size do you need? (e.g. 200 gaj, 10 marla, 3 BHK). Send *skip* if open.',
    hi: '📐 Kitna size chahiye? (jaise 200 gaj, 10 marla, 3 BHK). Fix na ho to *skip* likhein.',
    pa: '📐 ਕਿੰਨਾ ਸਾਈਜ਼ ਚਾਹੀਦਾ ਹੈ? (ਜਿਵੇਂ 200 ਗਜ, 10 ਮਰਲੇ, 3 BHK)। ਪੱਕਾ ਨਾ ਹੋਵੇ ਤਾਂ *skip* ਲਿਖੋ।',
    hi_deva: '📐 कितना साइज़ चाहिए? (जैसे 200 गज, 10 मरला, 3 BHK)। तय न हो तो *skip* लिखें।',
  },
  buyer_searching: {
    en: '🔎 Searching for: {summary}',
    hi: '🔎 Dhundh raha hoon: {summary}',
    pa: '🔎 ਲੱਭ ਰਿਹਾ ਹਾਂ: {summary}',
    hi_deva: '🔎 ढूँढ रहा हूँ: {summary}',
  },
  buyer_no_match: {
    en: '😕 I could not find a matching listing right now for: {summary}\nTry another area or budget (type *search*), or type *call* and our team will call you.',
    hi: '😕 Abhi iske liye koi matching listing nahi mili: {summary}\nDoosra area ya budget try karein (*search* likhein), ya *call* likhein, hamari team aapko call karegi.',
    pa: '😕 ਹੁਣ ਇਸ ਲਈ ਕੋਈ ਮੇਲ ਖਾਂਦੀ ਲਿਸਟਿੰਗ ਨਹੀਂ ਮਿਲੀ: {summary}\nਹੋਰ ਏਰੀਆ ਜਾਂ ਬਜਟ ਅਜ਼ਮਾਓ (*search* ਲਿਖੋ), ਜਾਂ *call* ਲਿਖੋ, ਸਾਡੀ ਟੀਮ ਤੁਹਾਨੂੰ ਫ਼ੋਨ ਕਰੇਗੀ।',
    hi_deva: '😕 अभी इसके लिए कोई मैचिंग लिस्टिंग नहीं मिली: {summary}\nदूसरा एरिया या बजट आज़माएँ (*search* लिखें), या *call* लिखें, हमारी टीम आपको कॉल करेगी।',
  },
  buyer_footer: {
    en: 'For a new search type *search*. To change role type *menu*.',
    hi: 'Nayi search ke liye *search* likhein. Role badalne ke liye *menu*.',
    pa: 'ਨਵੀਂ ਖੋਜ ਲਈ *search* ਲਿਖੋ। ਰੋਲ ਬਦਲਣ ਲਈ *menu*।',
    hi_deva: 'नई खोज के लिए *search* लिखें। रोल बदलने के लिए *menu*।',
  },
  buyer_call_ok: {
    en: '✅ Noted. Our team will call you on this number soon.',
    hi: '✅ Note kar liya. Hamari team jaldi isi number pe aapko call karegi.',
    pa: '✅ ਨੋਟ ਕਰ ਲਿਆ। ਸਾਡੀ ਟੀਮ ਜਲਦੀ ਇਸੇ ਨੰਬਰ \'ਤੇ ਤੁਹਾਨੂੰ ਫ਼ੋਨ ਕਰੇਗੀ।',
    hi_deva: '✅ नोट कर लिया। हमारी टीम जल्दी इसी नंबर पर आपको कॉल करेगी।',
  },

  // ------------------------------------------------------------ dealer flow
  dealer_ask_name: {
    en: '🎁 Dealers get a *{days}-day free trial*. After the trial you pay a monthly plan to keep adding listings (existing listings stay live). Type *plan* any time to see the plans.\n\nTo apply, send your *full name*.',
    hi: '🎁 Dealers ko *{days} din ka free trial* milta hai. Trial ke baad listings add karte rehne ke liye monthly plan ka payment karna hota hai (purani listings live rehti hain). Plans dekhne ke liye kabhi bhi *plan* likhein.\n\nApply karne ke liye apna *poora naam* bhejein.',
    pa: '🎁 Dealers ਨੂੰ *{days} ਦਿਨ ਦਾ ਮੁਫ਼ਤ ਟ੍ਰਾਇਲ* ਮਿਲਦਾ ਹੈ। ਟ੍ਰਾਇਲ ਤੋਂ ਬਾਅਦ ਲਿਸਟਿੰਗ ਪਾਉਂਦੇ ਰਹਿਣ ਲਈ ਮਹੀਨਾਵਾਰ ਪਲਾਨ ਦਾ ਭੁਗਤਾਨ ਕਰਨਾ ਪੈਂਦਾ ਹੈ (ਪੁਰਾਣੀਆਂ ਲਿਸਟਿੰਗਾਂ ਲਾਈਵ ਰਹਿੰਦੀਆਂ ਹਨ)। ਪਲਾਨ ਦੇਖਣ ਲਈ ਕਦੇ ਵੀ *plan* ਲਿਖੋ।\n\nਅਪਲਾਈ ਕਰਨ ਲਈ ਆਪਣਾ *ਪੂਰਾ ਨਾਮ* ਭੇਜੋ।',
    hi_deva: '🎁 Dealers को *{days} दिन का मुफ़्त ट्रायल* मिलता है। ट्रायल के बाद लिस्टिंग डालते रहने के लिए मासिक प्लान का भुगतान करना होता है (पुरानी लिस्टिंग लाइव रहती हैं)। प्लान देखने के लिए कभी भी *plan* लिखें।\n\nअप्लाई करने के लिए अपना *पूरा नाम* भेजें।',
  },
  dealer_ask_area: {
    en: '📍 Thanks, {name}. Which *area/city* do you work in?',
    hi: '📍 Shukriya, {name}. Aap *kis area/city* mein kaam karte hain?',
    pa: '📍 ਸ਼ੁਕਰੀਆ, {name}। ਤੁਸੀਂ *ਕਿਹੜੇ ਇਲਾਕੇ/ਸ਼ਹਿਰ* ਵਿੱਚ ਕੰਮ ਕਰਦੇ ਹੋ?',
    hi_deva: '📍 शुक्रिया, {name}। आप *किस एरिया/शहर* में काम करते हैं?',
  },
  dealer_submitted: {
    en: '✅ Your request has gone to the Plotraa team.\n👤 Name: {name}\n📍 Area: {area}\n\nWhat happens next:\n1. The team approves you (usually quickly) and you get a message here with your login and a link to set your password.\n2. Your *{days}-day free trial* starts from approval.\n3. Before the trial ends we remind you; to continue, pick a plan and pay (payment link or QR).\n\nTo change role type *menu*.',
    hi: '✅ Aapka request Plotraa team ko bhej diya hai.\n👤 Naam: {name}\n📍 Area: {area}\n\nAage kya hoga:\n1. Team aapko approve karegi (aam taur pe jaldi) aur yahin message aayega, jisme login aur password set karne ka link hoga.\n2. Approval se aapka *{days} din ka free trial* shuru hoga.\n3. Trial khatam hone se pehle reminder aayega; aage chalane ke liye plan chunke payment karein (payment link ya QR).\n\nRole badalne ke liye *menu* likhein.',
    pa: '✅ ਤੁਹਾਡੀ ਬੇਨਤੀ Plotraa ਟੀਮ ਨੂੰ ਭੇਜ ਦਿੱਤੀ ਹੈ।\n👤 ਨਾਮ: {name}\n📍 ਇਲਾਕਾ: {area}\n\nਅੱਗੇ ਕੀ ਹੋਵੇਗਾ:\n1. ਟੀਮ ਤੁਹਾਨੂੰ ਮਨਜ਼ੂਰ ਕਰੇਗੀ (ਆਮ ਤੌਰ \'ਤੇ ਜਲਦੀ) ਅਤੇ ਇੱਥੇ ਹੀ ਸੁਨੇਹਾ ਆਵੇਗਾ, ਜਿਸ ਵਿੱਚ ਲੌਗਿਨ ਅਤੇ ਪਾਸਵਰਡ ਸੈੱਟ ਕਰਨ ਦਾ ਲਿੰਕ ਹੋਵੇਗਾ।\n2. ਮਨਜ਼ੂਰੀ ਤੋਂ ਤੁਹਾਡਾ *{days} ਦਿਨ ਦਾ ਮੁਫ਼ਤ ਟ੍ਰਾਇਲ* ਸ਼ੁਰੂ ਹੋਵੇਗਾ।\n3. ਟ੍ਰਾਇਲ ਮੁੱਕਣ ਤੋਂ ਪਹਿਲਾਂ ਯਾਦ ਦਿਵਾਵਾਂਗੇ; ਅੱਗੇ ਚਲਾਉਣ ਲਈ ਪਲਾਨ ਚੁਣ ਕੇ ਭੁਗਤਾਨ ਕਰੋ (ਪੇਮੈਂਟ ਲਿੰਕ ਜਾਂ QR)।\n\nਰੋਲ ਬਦਲਣ ਲਈ *menu* ਲਿਖੋ।',
    hi_deva: '✅ आपका अनुरोध Plotraa टीम को भेज दिया है।\n👤 नाम: {name}\n📍 एरिया: {area}\n\nआगे क्या होगा:\n1. टीम आपको अप्रूव करेगी (आम तौर पर जल्दी) और यहीं मैसेज आएगा, जिसमें लॉगिन और पासवर्ड सेट करने का लिंक होगा।\n2. अप्रूवल से आपका *{days} दिन का मुफ़्त ट्रायल* शुरू होगा।\n3. ट्रायल खत्म होने से पहले रिमाइंडर आएगा; आगे चलाने के लिए प्लान चुनकर भुगतान करें (पेमेंट लिंक या QR)।\n\nरोल बदलने के लिए *menu* लिखें।',
  },
  dealer_pending: {
    en: '🕒 Your request to join is already with the Plotraa team (Name: {name}, Area: {area}). You will get a message here as soon as it is approved. To change role type *menu*.',
    hi: '🕒 Aapka join request Plotraa team ke paas hai (Naam: {name}, Area: {area}). Approve hote hi yahin message aayega. Role badalne ke liye *menu* likhein.',
    pa: '🕒 ਤੁਹਾਡੀ ਜੁੜਨ ਦੀ ਬੇਨਤੀ Plotraa ਟੀਮ ਕੋਲ ਹੈ (ਨਾਮ: {name}, ਇਲਾਕਾ: {area})। ਮਨਜ਼ੂਰ ਹੁੰਦੇ ਹੀ ਇੱਥੇ ਸੁਨੇਹਾ ਆਵੇਗਾ। ਰੋਲ ਬਦਲਣ ਲਈ *menu* ਲਿਖੋ।',
    hi_deva: '🕒 आपका जुड़ने का अनुरोध Plotraa टीम के पास है (नाम: {name}, एरिया: {area})। अप्रूव होते ही यहीं मैसेज आएगा। रोल बदलने के लिए *menu* लिखें।',
  },
  dealer_rejected: {
    en: 'An earlier request from this number was not approved. Our team will talk to you about it.',
    hi: 'Is number se pehle bheja gaya request approve nahi hua tha. Hamari team is baare mein aapse baat karegi.',
    pa: 'ਇਸ ਨੰਬਰ ਤੋਂ ਪਹਿਲਾਂ ਭੇਜੀ ਬੇਨਤੀ ਮਨਜ਼ੂਰ ਨਹੀਂ ਹੋਈ ਸੀ। ਸਾਡੀ ਟੀਮ ਇਸ ਬਾਰੇ ਤੁਹਾਡੇ ਨਾਲ ਗੱਲ ਕਰੇਗੀ।',
    hi_deva: 'इस नंबर से पहले भेजा गया अनुरोध अप्रूव नहीं हुआ था। हमारी टीम इस बारे में आपसे बात करेगी।',
  },

  // --------------------------------------------------------- generic / misc
  greet_done: {
    en: 'Hello! 👋 How can I help? To start again type *menu*.',
    hi: 'Namaste! 👋 Main kya madad karoon? Dobara shuru karne ke liye *menu* likhein.',
    pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! 👋 ਮੈਂ ਕੀ ਮਦਦ ਕਰਾਂ? ਦੁਬਾਰਾ ਸ਼ੁਰੂ ਕਰਨ ਲਈ *menu* ਲਿਖੋ।',
    hi_deva: 'नमस्ते! 👋 मैं क्या मदद करूँ? दोबारा शुरू करने के लिए *menu* लिखें।',
  },
  question_then_step: {
    en: 'Back to your details: {prompt}',
    hi: 'Ab aapki details par wapas: {prompt}',
    pa: 'ਹੁਣ ਤੁਹਾਡੇ ਵੇਰਵਿਆਂ \'ਤੇ ਵਾਪਸ: {prompt}',
    hi_deva: 'अब आपकी डिटेल्स पर वापस: {prompt}',
  },
  yearly_unknown: {
    en: 'Our plans are billed monthly and I do not have any yearly plan or yearly benefit details. Type *plan* for the live plan list, or ask the team: {support}.',
    hi: 'Hamare plans monthly hain; yearly plan ya yearly benefit ki koi jaankari mere paas nahi hai. Live plan list ke liye *plan* likhein, ya team se poochein: {support}.',
    pa: 'ਸਾਡੇ ਪਲਾਨ ਮਹੀਨਾਵਾਰ ਹਨ; ਸਾਲਾਨਾ ਪਲਾਨ ਜਾਂ ਸਾਲਾਨਾ ਫ਼ਾਇਦੇ ਬਾਰੇ ਮੇਰੇ ਕੋਲ ਕੋਈ ਜਾਣਕਾਰੀ ਨਹੀਂ ਹੈ। ਲਾਈਵ ਪਲਾਨ ਲਿਸਟ ਲਈ *plan* ਲਿਖੋ, ਜਾਂ ਟੀਮ ਨੂੰ ਪੁੱਛੋ: {support}।',
    hi_deva: 'हमारे प्लान मासिक हैं; सालाना प्लान या सालाना फ़ायदे की कोई जानकारी मेरे पास नहीं है। लाइव प्लान लिस्ट के लिए *plan* लिखें, या टीम से पूछें: {support}।',
  },

  // ----------------------------------------------------------- agent copy
  agent_greeting: {
    en: 'Hi{name}! 👋 Send me property details anytime and I will create the listing. Type "help" to see everything I can do.',
    hi: 'Namaste{name}! 👋 Property ki details bhejiye, main listing bana dunga. Sab options dekhne ke liye "help" likhein.',
    pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ{name}! 👋 ਪ੍ਰਾਪਰਟੀ ਦੇ ਵੇਰਵੇ ਭੇਜੋ, ਮੈਂ ਲਿਸਟਿੰਗ ਬਣਾ ਦੇਵਾਂਗਾ। ਸਾਰੇ ਵਿਕਲਪ ਦੇਖਣ ਲਈ "help" ਲਿਖੋ।',
    hi_deva: 'नमस्ते{name}! 👋 प्रॉपर्टी की डिटेल्स भेजिए, मैं लिस्टिंग बना दूँगा। सारे विकल्प देखने के लिए "help" लिखें।',
  },
  agent_help: {
    en: `Here's what you can do — just type normally, no special commands needed:\n\n🏠 *Add a property*: "3 BHK kothi Model Town Ludhiana 1.2 crore"\n📋 *See your listings*: "show my listings"\n✅ *Mark sold*: "Model Town plot is sold"\n🔎 *Find a property for a client*: "any 200 gaj plot in Dugri?"\n💳 *Plans and payment*: type "plan" to see plans and get the online payment link\n📍 Share a location pin anytime to fix a property's map location.\n🎤 Prefer talking? Send a voice note instead of typing, in any language.`,
    hi: 'Aap normal tarike se likh sakte hain, koi command yaad rakhne ki zaroorat nahi:\n\n🏠 *Property add karein*: "3 BHK kothi Model Town Ludhiana 1.2 crore"\n📋 *Apni listings dekhein*: "meri listings dikhao"\n✅ *Sold mark karein*: "Model Town wala plot bik gaya"\n🔎 *Client ke liye property dhundein*: "Dugri mein 200 gaj plot hai koi?"\n💳 *Plan aur payment*: "plan" likhein, plans aur online payment ka link mil jayega\n📍 Property ki location theek karne ke liye kabhi bhi location pin bhej dein.\n🎤 Type nahi karna? Voice note bhej dein, Punjabi/Hindi/English kuch bhi.',
    pa: 'ਤੁਸੀਂ ਆਮ ਤਰੀਕੇ ਨਾਲ ਲਿਖ ਸਕਦੇ ਹੋ, ਕੋਈ ਕਮਾਂਡ ਯਾਦ ਰੱਖਣ ਦੀ ਲੋੜ ਨਹੀਂ:\n\n🏠 *ਪ੍ਰਾਪਰਟੀ ਜੋੜੋ*: "3 BHK ਕੋਠੀ ਮਾਡਲ ਟਾਊਨ ਲੁਧਿਆਣਾ 1.2 ਕਰੋੜ"\n📋 *ਆਪਣੀਆਂ ਲਿਸਟਿੰਗਾਂ ਦੇਖੋ*: "ਮੇਰੀਆਂ ਲਿਸਟਿੰਗਾਂ ਦਿਖਾਓ"\n✅ *ਵਿਕ ਗਈ ਮਾਰਕ ਕਰੋ*: "ਮਾਡਲ ਟਾਊਨ ਵਾਲਾ ਪਲਾਟ ਵਿਕ ਗਿਆ"\n🔎 *ਗਾਹਕ ਲਈ ਪ੍ਰਾਪਰਟੀ ਲੱਭੋ*: "ਦੁੱਗਰੀ ਵਿੱਚ 200 ਗਜ ਪਲਾਟ ਹੈ ਕੋਈ?"\n💳 *ਪਲਾਨ ਅਤੇ ਪੇਮੈਂਟ*: "plan" ਲਿਖੋ, ਪਲਾਨ ਅਤੇ ਆਨਲਾਈਨ ਪੇਮੈਂਟ ਦਾ ਲਿੰਕ ਮਿਲ ਜਾਵੇਗਾ\n📍 ਪ੍ਰਾਪਰਟੀ ਦੀ ਲੋਕੇਸ਼ਨ ਠੀਕ ਕਰਨ ਲਈ ਕਦੇ ਵੀ ਲੋਕੇਸ਼ਨ ਪਿੰਨ ਭੇਜ ਦਿਓ।\n🎤 ਲਿਖਣਾ ਨਹੀਂ? ਵੌਇਸ ਨੋਟ ਭੇਜ ਦਿਓ, ਪੰਜਾਬੀ/ਹਿੰਦੀ/ਅੰਗਰੇਜ਼ੀ ਕੁਝ ਵੀ।',
    hi_deva: 'आप सामान्य तरीके से लिख सकते हैं, कोई कमांड याद रखने की ज़रूरत नहीं:\n\n🏠 *प्रॉपर्टी जोड़ें*: "3 BHK कोठी मॉडल टाउन लुधियाना 1.2 करोड़"\n📋 *अपनी लिस्टिंग देखें*: "मेरी लिस्टिंग दिखाओ"\n✅ *बिक गई मार्क करें*: "मॉडल टाउन वाला प्लॉट बिक गया"\n🔎 *क्लाइंट के लिए प्रॉपर्टी ढूँढें*: "दुगरी में 200 गज प्लॉट है कोई?"\n💳 *प्लान और पेमेंट*: "plan" लिखें, प्लान और ऑनलाइन पेमेंट का लिंक मिल जाएगा\n📍 प्रॉपर्टी की लोकेशन ठीक करने के लिए कभी भी लोकेशन पिन भेज दें।\n🎤 टाइप नहीं करना? वॉइस नोट भेज दें, पंजाबी/हिंदी/अंग्रेज़ी कुछ भी।',
  },
  plan_menu_header: {
    en: '📦 *Choose your plan* — reply with its number:',
    hi: '📦 *Apna plan chuniye* — uska number reply karein:',
    pa: '📦 *ਆਪਣਾ ਪਲਾਨ ਚੁਣੋ* — ਉਸ ਦਾ ਨੰਬਰ ਭੇਜੋ:',
    hi_deva: '📦 *अपना प्लान चुनिए* — उसका नंबर भेजें:',
  },
  plan_menu_footer: {
    en: 'Prices include GST. You can list properties either way; this just sets up your payment plan.',
    hi: 'Price GST ke saath hai. Plan chunne se pehle bhi listing kar sakte hain; ye bas aapka payment plan set karta hai.',
    pa: 'ਕੀਮਤ GST ਸਮੇਤ ਹੈ। ਤੁਸੀਂ ਪਲਾਨ ਚੁਣਨ ਤੋਂ ਪਹਿਲਾਂ ਵੀ ਲਿਸਟਿੰਗ ਕਰ ਸਕਦੇ ਹੋ; ਇਹ ਸਿਰਫ਼ ਤੁਹਾਡਾ ਪੇਮੈਂਟ ਪਲਾਨ ਸੈੱਟ ਕਰਦਾ ਹੈ।',
    hi_deva: 'कीमत GST सहित है। प्लान चुनने से पहले भी लिस्टिंग कर सकते हैं; यह बस आपका पेमेंट प्लान सेट करता है।',
  },
  plan_menu_visitor_footer: {
    en: 'Prices include GST. New dealers get a {days}-day free trial first. To join as a dealer type *menu* and choose 2.',
    hi: 'Price GST ke saath hai. Naye dealers ko pehle {days} din ka free trial milta hai. Dealer ke roop mein judne ke liye *menu* likhein aur 2 chunein.',
    pa: 'ਕੀਮਤ GST ਸਮੇਤ ਹੈ। ਨਵੇਂ dealers ਨੂੰ ਪਹਿਲਾਂ {days} ਦਿਨ ਦਾ ਮੁਫ਼ਤ ਟ੍ਰਾਇਲ ਮਿਲਦਾ ਹੈ। Dealer ਵਜੋਂ ਜੁੜਨ ਲਈ *menu* ਲਿਖੋ ਅਤੇ 2 ਚੁਣੋ।',
    hi_deva: 'कीमत GST सहित है। नए dealers को पहले {days} दिन का मुफ़्त ट्रायल मिलता है। Dealer के रूप में जुड़ने के लिए *menu* लिखें और 2 चुनें।',
  },
  plans_list_header: {
    en: '📦 *Plotraa plans* (billed monthly):',
    hi: '📦 *Plotraa plans* (monthly):',
    pa: '📦 *Plotraa ਪਲਾਨ* (ਮਹੀਨਾਵਾਰ):',
    hi_deva: '📦 *Plotraa प्लान* (मासिक):',
  },
  plan_none: {
    en: 'Plan details will be shared with you shortly.',
    hi: 'Plan ki details aapko jaldi bhej di jayengi.',
    pa: 'ਪਲਾਨ ਦੇ ਵੇਰਵੇ ਤੁਹਾਨੂੰ ਜਲਦੀ ਭੇਜ ਦਿੱਤੇ ਜਾਣਗੇ।',
    hi_deva: 'प्लान की डिटेल्स आपको जल्दी भेज दी जाएँगी।',
  },
  plan_selected_link: {
    en: '✅ *{plan}* plan selected — ₹{price}/month.\n\n💳 Pay here: {link}\nYour plan activates automatically as soon as the payment is done.',
    hi: '✅ *{plan}* plan chun liya — ₹{price}/month.\n\n💳 Yahan pay karein: {link}\nPayment hote hi aapka plan apne aap active ho jayega.',
    pa: '✅ *{plan}* ਪਲਾਨ ਚੁਣ ਲਿਆ — ₹{price}/ਮਹੀਨਾ।\n\n💳 ਇੱਥੇ ਭੁਗਤਾਨ ਕਰੋ: {link}\nਭੁਗਤਾਨ ਹੁੰਦੇ ਹੀ ਤੁਹਾਡਾ ਪਲਾਨ ਆਪਣੇ-ਆਪ ਚਾਲੂ ਹੋ ਜਾਵੇਗਾ।',
    hi_deva: '✅ *{plan}* प्लान चुन लिया — ₹{price}/माह।\n\n💳 यहाँ भुगतान करें: {link}\nभुगतान होते ही आपका प्लान अपने-आप चालू हो जाएगा।',
  },
  plan_selected_qr: {
    en: '✅ *{plan}* plan selected — ₹{price}/month.\n\nScan this QR to pay:\n{qr}\n\nOnce paid, send a photo of your payment receipt any time (or just type "payment") to confirm it with us.',
    hi: '✅ *{plan}* plan chun liya — ₹{price}/month.\n\nPay karne ke liye ye QR scan karein:\n{qr}\n\nPay karne ke baad receipt ki photo bhejein (ya bas "payment" likhein), hum confirm kar denge.',
    pa: '✅ *{plan}* ਪਲਾਨ ਚੁਣ ਲਿਆ — ₹{price}/ਮਹੀਨਾ।\n\nਭੁਗਤਾਨ ਲਈ ਇਹ QR ਸਕੈਨ ਕਰੋ:\n{qr}\n\nਭੁਗਤਾਨ ਤੋਂ ਬਾਅਦ ਰਸੀਦ ਦੀ ਫੋਟੋ ਭੇਜੋ (ਜਾਂ ਸਿਰਫ਼ "payment" ਲਿਖੋ), ਅਸੀਂ ਪੁਸ਼ਟੀ ਕਰ ਦੇਵਾਂਗੇ।',
    hi_deva: '✅ *{plan}* प्लान चुन लिया — ₹{price}/माह।\n\nभुगतान के लिए यह QR स्कैन करें:\n{qr}\n\nभुगतान के बाद रसीद की फ़ोटो भेजें (या बस "payment" लिखें), हम पुष्टि कर देंगे।',
  },
  plan_selected_noqr: {
    en: '✅ *{plan}* plan selected — ₹{price}/month.\n\nThe payment option for this plan is not ready yet. I have told the Plotraa team and they will send it to you on this chat. You can list properties in the meantime.',
    hi: '✅ *{plan}* plan chun liya — ₹{price}/month.\n\nIs plan ka payment option abhi ready nahi hai. Plotraa team ko bata diya hai, wo yahin bhej degi. Tab tak aap listing kar sakte hain.',
    pa: '✅ *{plan}* ਪਲਾਨ ਚੁਣ ਲਿਆ — ₹{price}/ਮਹੀਨਾ।\n\nਇਸ ਪਲਾਨ ਦਾ ਭੁਗਤਾਨ ਵਿਕਲਪ ਹਾਲੇ ਤਿਆਰ ਨਹੀਂ ਹੈ। Plotraa ਟੀਮ ਨੂੰ ਦੱਸ ਦਿੱਤਾ ਹੈ, ਉਹ ਇੱਥੇ ਹੀ ਭੇਜ ਦੇਵੇਗੀ। ਉਦੋਂ ਤੱਕ ਤੁਸੀਂ ਲਿਸਟਿੰਗ ਕਰ ਸਕਦੇ ਹੋ।',
    hi_deva: '✅ *{plan}* प्लान चुन लिया — ₹{price}/माह।\n\nइस प्लान का पेमेंट विकल्प अभी तैयार नहीं है। Plotraa टीम को बता दिया है, वो यहीं भेज देगी। तब तक आप लिस्टिंग कर सकते हैं।',
  },
  plan_current: {
    en: '📦 Your plan: *{plan}* — ₹{price}/month\nStatus: {status}{trial}\n\n{pay}',
    hi: '📦 Aapka plan: *{plan}* — ₹{price}/month\nStatus: {status}{trial}\n\n{pay}',
    pa: '📦 ਤੁਹਾਡਾ ਪਲਾਨ: *{plan}* — ₹{price}/ਮਹੀਨਾ\nਸਥਿਤੀ: {status}{trial}\n\n{pay}',
    hi_deva: '📦 आपका प्लान: *{plan}* — ₹{price}/माह\nस्थिति: {status}{trial}\n\n{pay}',
  },
  plan_pay_link: {
    en: '💳 Pay here: {link}',
    hi: '💳 Yahan pay karein: {link}',
    pa: '💳 ਇੱਥੇ ਭੁਗਤਾਨ ਕਰੋ: {link}',
    hi_deva: '💳 यहाँ भुगतान करें: {link}',
  },
  plan_pay_receipt: {
    en: 'After paying by QR, type "payment" and send the payment screenshot.',
    hi: 'QR se pay karne ke baad "payment" likhein aur payment ka screenshot bhejein.',
    pa: 'QR ਨਾਲ ਭੁਗਤਾਨ ਤੋਂ ਬਾਅਦ "payment" ਲਿਖੋ ਅਤੇ ਪੇਮੈਂਟ ਦਾ ਸਕ੍ਰੀਨਸ਼ਾਟ ਭੇਜੋ।',
    hi_deva: 'QR से भुगतान के बाद "payment" लिखें और पेमेंट का स्क्रीनशॉट भेजें।',
  },
  status_trial: {
    en: 'Free trial', hi: 'Free trial', pa: 'ਮੁਫ਼ਤ ਟ੍ਰਾਇਲ', hi_deva: 'मुफ़्त ट्रायल',
  },
  status_paid: {
    en: 'Paid ✅', hi: 'Paid ✅', pa: 'ਭੁਗਤਾਨ ਹੋ ਗਿਆ ✅', hi_deva: 'भुगतान हो गया ✅',
  },
  status_expired: {
    en: 'Trial ended — payment needed', hi: 'Trial khatam — payment chahiye', pa: 'ਟ੍ਰਾਇਲ ਖ਼ਤਮ — ਭੁਗਤਾਨ ਚਾਹੀਦਾ', hi_deva: 'ट्रायल खत्म — भुगतान चाहिए',
  },
  status_pending_review: {
    en: 'Receipt under review 🕒', hi: 'Receipt check ho rahi hai 🕒', pa: 'ਰਸੀਦ ਦੀ ਜਾਂਚ ਹੋ ਰਹੀ ਹੈ 🕒', hi_deva: 'रसीद की जाँच हो रही है 🕒',
  },
  status_unpaid: {
    en: 'Unpaid', hi: 'Pending', pa: 'ਬਾਕੀ', hi_deva: 'बाकी',
  },
  trial_line: {
    en: '\n🎁 Free trial ends on *{date}* ({days} left)',
    hi: '\n🎁 Free trial *{date}* ko khatam hoga ({days} baaki)',
    pa: '\n🎁 ਮੁਫ਼ਤ ਟ੍ਰਾਇਲ *{date}* ਨੂੰ ਖ਼ਤਮ ਹੋਵੇਗਾ ({days} ਬਾਕੀ)',
    hi_deva: '\n🎁 मुफ़्त ट्रायल *{date}* को खत्म होगा ({days} बाकी)',
  },
  trial_days_left: {
    en: '{n} day(s)', hi: '{n} din', pa: '{n} ਦਿਨ', hi_deva: '{n} दिन',
  },
  trial_reminder: {
    en: '⏰ Your Plotraa free trial ends in *{when}* (on {date}).\nTo keep adding listings, pick a plan and pay.\n{pay}\nType *plan* to see the plans.',
    hi: '⏰ Aapka Plotraa free trial *{when}* mein khatam ho raha hai ({date} ko).\nListing chalu rakhne ke liye plan chunke payment kar dijiye.\n{pay}\nPlans dekhne ke liye *plan* likhein.',
    pa: '⏰ ਤੁਹਾਡਾ Plotraa ਮੁਫ਼ਤ ਟ੍ਰਾਇਲ *{when}* ਵਿੱਚ ਖ਼ਤਮ ਹੋ ਰਿਹਾ ਹੈ ({date} ਨੂੰ)।\nਲਿਸਟਿੰਗ ਚਾਲੂ ਰੱਖਣ ਲਈ ਪਲਾਨ ਚੁਣ ਕੇ ਭੁਗਤਾਨ ਕਰੋ।\n{pay}\nਪਲਾਨ ਦੇਖਣ ਲਈ *plan* ਲਿਖੋ।',
    hi_deva: '⏰ आपका Plotraa मुफ़्त ट्रायल *{when}* में खत्म हो रहा है ({date} को)।\nलिस्टिंग चालू रखने के लिए प्लान चुनकर भुगतान करें।\n{pay}\nप्लान देखने के लिए *plan* लिखें।',
  },
  trial_expired: {
    en: '⛔ Your free trial ended on {date}.\nNew listings are paused and new leads stay with the Plotraa team. Your existing listings stay live.\nPay to switch everything back on.\n{pay}\nType *plan* to see the plans.',
    hi: '⛔ Aapka free trial {date} ko khatam ho gaya.\nAb nayi listing add nahi ho sakti aur naye leads Plotraa team ke paas rahenge. Aapki purani listings live rahengi.\nPayment karte hi sab dobara chalu.\n{pay}\nPlans ke liye *plan* likhein.',
    pa: '⛔ ਤੁਹਾਡਾ ਮੁਫ਼ਤ ਟ੍ਰਾਇਲ {date} ਨੂੰ ਖ਼ਤਮ ਹੋ ਗਿਆ।\nਹੁਣ ਨਵੀਂ ਲਿਸਟਿੰਗ ਨਹੀਂ ਜੁੜ ਸਕਦੀ ਅਤੇ ਨਵੇਂ ਲੀਡ Plotraa ਟੀਮ ਕੋਲ ਰਹਿਣਗੇ। ਪੁਰਾਣੀਆਂ ਲਿਸਟਿੰਗਾਂ ਲਾਈਵ ਰਹਿਣਗੀਆਂ।\nਭੁਗਤਾਨ ਕਰਦੇ ਹੀ ਸਭ ਦੁਬਾਰਾ ਚਾਲੂ।\n{pay}\nਪਲਾਨ ਲਈ *plan* ਲਿਖੋ।',
    hi_deva: '⛔ आपका मुफ़्त ट्रायल {date} को खत्म हो गया।\nअब नई लिस्टिंग नहीं जुड़ सकती और नए लीड Plotraa टीम के पास रहेंगे। पुरानी लिस्टिंग लाइव रहेंगी।\nभुगतान करते ही सब दोबारा चालू।\n{pay}\nप्लान के लिए *plan* लिखें।',
  },
  trial_when_tomorrow: {
    en: '1 day', hi: 'kal (1 din)', pa: '1 ਦਿਨ', hi_deva: '1 दिन',
  },
  paid_confirmed: {
    en: '✅ Payment received for the *{plan}* plan. Thank you! Your plan is active and new listings and leads are switched on.',
    hi: '✅ *{plan}* plan ka payment mil gaya. Dhanyavaad! Aapka plan active hai, nayi listings aur leads chalu hain.',
    pa: '✅ *{plan}* ਪਲਾਨ ਦਾ ਭੁਗਤਾਨ ਮਿਲ ਗਿਆ। ਧੰਨਵਾਦ! ਤੁਹਾਡਾ ਪਲਾਨ ਚਾਲੂ ਹੈ, ਨਵੀਆਂ ਲਿਸਟਿੰਗਾਂ ਅਤੇ ਲੀਡ ਚਾਲੂ ਹਨ।',
    hi_deva: '✅ *{plan}* प्लान का भुगतान मिल गया। धन्यवाद! आपका प्लान चालू है, नई लिस्टिंग और लीड चालू हैं।',
  },
  cold_greeting_dealer_number: {
    en: 'Hi there! 👋 Tell me the area and type (e.g. "plots in Ludhiana") and I will show you available listings.',
    hi: 'Namaste! 👋 Area aur type batayein (jaise "Ludhiana mein plot") aur main available listings dikha dunga.',
    pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! 👋 ਏਰੀਆ ਅਤੇ ਕਿਸਮ ਦੱਸੋ (ਜਿਵੇਂ "ਲੁਧਿਆਣਾ ਵਿੱਚ ਪਲਾਟ") ਅਤੇ ਮੈਂ ਉਪਲਬਧ ਲਿਸਟਿੰਗਾਂ ਦਿਖਾ ਦੇਵਾਂਗਾ।',
    hi_deva: 'नमस्ते! 👋 एरिया और टाइप बताएँ (जैसे "लुधियाना में प्लॉट") और मैं उपलब्ध लिस्टिंग दिखा दूँगा।',
  },
};

/**
 * Text for `key` in variant `v` ('en' | 'hi' | 'pa' | 'hi_deva') with {vars}
 * filled in. Unknown keys throw so a typo fails in tests, not in production.
 */
function t(key, v, vars = {}) {
  const entry = M[key];
  if (!entry) throw new Error(`i18n: unknown key "${key}"`);
  const text = entry[v] || entry.hi;
  return text.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined || vars[name] === null ? '' : String(vars[name])));
}

module.exports = { t, variantFor, MESSAGES: M };
