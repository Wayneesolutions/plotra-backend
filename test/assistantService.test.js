const test = require('node:test');
const assert = require('node:assert');

const { parseAssistantOutput, formatPlansForPrompt, looksLikeSupportRequest, buildSystemPrompt } = require('../src/services/assistantService');
const { buildAlertText } = require('../src/services/supportRequestService');

test('parseAssistantOutput accepts a good reply and normalises fields', () => {
  const out = parseAssistantOutput(JSON.stringify({
    reply: '  Haan ji, pin se map bilkul sahi ghar pe lagta hai.  ',
    action: 'support', support_kind: 'complaint', summary: ' Payment approved nahi hua ',
  }));
  assert.strictEqual(out.reply, 'Haan ji, pin se map bilkul sahi ghar pe lagta hai.');
  assert.strictEqual(out.action, 'support');
  assert.strictEqual(out.supportKind, 'complaint');
  assert.strictEqual(out.summary, 'Payment approved nahi hua');
});

test('parseAssistantOutput rejects junk and defaults unknown actions to none', () => {
  assert.strictEqual(parseAssistantOutput('not json'), null);
  assert.strictEqual(parseAssistantOutput('{"reply":"   "}'), null);
  assert.strictEqual(parseAssistantOutput('{"action":"support"}'), null);
  const out = parseAssistantOutput('{"reply":"ok","action":"give_discount","support_kind":"weird"}');
  assert.strictEqual(out.action, 'none');
  assert.strictEqual(out.supportKind, 'problem');
});

test('parseAssistantOutput caps reply length and cleans seller fields', () => {
  const out = parseAssistantOutput(JSON.stringify({
    reply: 'x'.repeat(5000), action: 'seller_lead', summary: 'Owner wants to sell',
    seller: { property_type: 'Kothi', city: ' Ludhiana ', locality: '', expected_price: 120, size_text: null },
  }));
  assert.strictEqual(out.reply.length, 1200);
  assert.deepStrictEqual(out.seller, { property_type: 'Kothi', city: 'Ludhiana', locality: null, expected_price: null, size_text: null });
});

test('formatPlansForPrompt shows price, discount and features exactly', () => {
  const text = formatPlansForPrompt([
    { label: 'Basic', price_inr: 4999, discount_percent: 40, features: '["1 user","Up to 100 listings/month"]' },
    { label: 'Basic with Leads', price_inr: 7999, discount_percent: 30, features: ['30 leads included'] },
    { label: 'Custom', price_inr: 25000, discount_percent: null, features: null },
  ]);
  assert.match(text, /Basic: ₹4,999\/month \(40% off\)\. Includes: 1 user; Up to 100 listings\/month/);
  assert.match(text, /Basic with Leads: ₹7,999\/month \(30% off\)\. Includes: 30 leads included/);
  assert.match(text, /Custom: ₹25,000\/month$/m);
  assert.match(formatPlansForPrompt([]), /not available/);
});

test('looksLikeSupportRequest catches obvious help/call requests only', () => {
  for (const t of ['mujhe call karo', 'koi problem aa rahi hai', 'listing nahi ho rahi, help', 'payment ka issue hai', 'team se baat karni hai', 'please call back']) {
    assert.ok(looksLikeSupportRequest(t), t);
  }
  for (const t of ['Model Town mein 200 gaj kothi 1.2 crore', 'haan publish karo', 'meri listings dikhao']) {
    assert.ok(!looksLikeSupportRequest(t), t);
  }
});

test('system prompt carries the no-hard-sell and same-price rules plus live plans', () => {
  process.env.PLOTRAA_TRIAL_OFFER = '';
  const prompt = buildSystemPrompt({ audience: 'visitor', contextText: 'CONTEXT X', plansText: 'PLANS Y' });
  assert.match(prompt, /not a salesperson/);
  assert.match(prompt, /never invent or negotiate a discount/);
  assert.match(prompt, /PLANS Y/);
  assert.match(prompt, /CONTEXT X/);
  assert.match(prompt, /No other trial or offer is configured/);
  process.env.PLOTRAA_TRIAL_OFFER = '7-day free trial for every new agent.';
  assert.match(buildSystemPrompt({ audience: 'agent', contextText: '', plansText: '' }), /7-day free trial for every new agent\./);
  delete process.env.PLOTRAA_TRIAL_OFFER;
});

test('buildAlertText gives the team everything to call back', () => {
  const text = buildAlertText({
    name: 'Gurpreet', businessName: 'GS Properties', phone: '+919812345678', audience: 'agent', kind: 'problem',
    summary: 'Paid via QR yesterday, still blocked from adding listings', lastMessage: 'payment kar di phir bhi listing add nahi ho rahi',
  });
  assert.match(text, /Agent needs help/);
  assert.match(text, /Gurpreet \(GS Properties\)/);
  assert.match(text, /wa\.me\/919812345678/);
  assert.match(text, /still blocked/);
  assert.match(text, /listing add nahi ho rahi/);
});

const { signupFollowUp } = require('../src/services/agentSignupService');

test('parseAssistantOutput keeps start_signup and only stated signup fields', () => {
  const out = parseAssistantOutput(JSON.stringify({ reply: 'Zaroor!', action: 'start_signup', signup: { name: ' Rajesh Kumar ', area: '' } }));
  assert.strictEqual(out.action, 'start_signup');
  assert.deepStrictEqual(out.signup, { name: 'Rajesh Kumar', area: null });
  assert.strictEqual(parseAssistantOutput('{"reply":"hi"}').signup, null);
});

test('signupFollowUp asks only for what is missing, in the right language', () => {
  assert.match(signupFollowUp({ name: null, address: null, lang: 'hi' }), /poora naam.*aur.*kis area\/city/);
  assert.match(signupFollowUp({ name: 'Rajesh', address: null, lang: 'hi' }), /kis area\/city/);
  assert.doesNotMatch(signupFollowUp({ name: 'Rajesh', address: null, lang: 'hi' }), /naam/);
  assert.match(signupFollowUp({ name: null, address: 'Ludhiana', lang: 'en' }), /full name/);
  assert.strictEqual(signupFollowUp({ name: 'A', address: 'B', lang: 'en' }), null);
  const done = signupFollowUp({ name: 'Rajesh', address: 'Dugri, Ludhiana', justCompleted: true, lang: 'hi' });
  assert.match(done, /Ho gaya/); assert.match(done, /Rajesh/); assert.match(done, /approval/);
});

test('system prompt explains flexible joining and the first-message welcome', () => {
  const prompt = buildSystemPrompt({ audience: 'visitor', contextText: '', plansText: '' });
  assert.match(prompt, /"start_signup"/);
  assert.match(prompt, /in ANY wording/);
  assert.match(prompt, /FIRST MESSAGE/);
  assert.match(prompt, /Do NOT ask for their name or area yourself/);
});

test('sellerIntent flags owners selling, not buyers searching', () => {
  const { looksLikeSellerIntent, extractSellerHints } = require('../src/utils/sellerIntent');
  assert.ok(looksLikeSellerIntent('meri Dugri wali kothi bechni hai 1.5 crore'));
  assert.ok(looksLikeSellerIntent('Mujhe apna plot bechna hai'));
  assert.ok(looksLikeSellerIntent('I want to sell my house in Model Town'));
  assert.ok(!looksLikeSellerIntent('plots for sale in Dugri under 80 lakh'));
  assert.ok(!looksLikeSellerIntent('Dugri mein 200 gaj plot chahiye'));
  const h = extractSellerHints('meri Dugri wali kothi bechni hai 1.5 crore, 200 gaj');
  assert.deepStrictEqual(h, { property_type: 'Villa', expected_price: '1.5 crore', size_text: '200 gaj' });
});

test('detectReplyLanguage treats Hinglish selling/joining messages as Hindi', () => {
  const { detectReplyLanguage } = require('../src/utils/replyLanguage');
  assert.strictEqual(detectReplyLanguage('meri Dugri wali kothi bechni hai 1.5 crore'), 'hi');
  assert.strictEqual(detectReplyLanguage('main dealer hoon, judna hai'), 'hi');
  assert.strictEqual(detectReplyLanguage('Plot in Model Town, Ludhiana, pincode 141001, 45 lakh'), 'en');
  assert.strictEqual(detectReplyLanguage('I want to join as a dealer in Ludhiana'), 'en');
});

test('listing status meanings never blame the location pin', () => {
  const { LISTING_STATUS_MEANING } = require('../src/services/assistantService');
  assert.match(LISTING_STATUS_MEANING.awaiting_approval, /haan|yes/);
  assert.match(LISTING_STATUS_MEANING.awaiting_approval, /pin is NOT the reason/);
});

test('plain questions are not support requests, real problems still are', () => {
  const { isPlainQuestion } = require('../src/services/assistantService');
  for (const t of ['support number kya hai', 'Support number?', 'plan upgrade kaise karu', 'Discount?', 'dashboard login kaise karu']) {
    assert.ok(isPlainQuestion(t), t);
    assert.ok(!looksLikeSupportRequest(t), t);
  }
  for (const t of ['payment kar di phir bhi plan active nahi hua, help', 'mujhe call karo', 'listing live nahi ho rahi? problem hai']) {
    assert.ok(!isPlainQuestion(t), t);
  }
});

test('discount replies are cut to a short answer', () => {
  const { capShortReply } = require('../src/services/assistantService');
  const long = `Basic has 10% off. ${'Pro includes many things. '.repeat(30)}`;
  assert.ok(capShortReply(long, 'Discount?').length <= 280);
  assert.equal(capShortReply(long, 'plans kya hain'), long);
  assert.equal(capShortReply('Short.', 'Discount?'), 'Short.');
});

test('knowledge has the support number, upgrade steps and the two web forms', () => {
  const { PRODUCT, RULES } = require('../src/assistant/plotraaKnowledge');
  assert.match(PRODUCT, /Support number: /);
  assert.match(PRODUCT, /UPGRADING A PLAN/);
  assert.match(PRODUCT, /\/request-access/);
  assert.match(RULES, /Aap dealer hain ya property owner\?/);
  assert.match(RULES, /request-access/);
  assert.match(RULES, /sell-property/);
});

test('signup follow-up speaks Gurmukhi to a Gurmukhi writer', () => {
  const { signupFollowUp } = require('../src/services/agentSignupService');
  assert.match(signupFollowUp({ name: 'ਗੁਰਪ੍ਰੀਤ', address: 'ਦੁੱਗਰੀ', justCompleted: true, lang: 'hi', script: 'gurmukhi' }), /ਹੋ ਗਿਆ/);
  assert.match(signupFollowUp({ name: null, address: 'x', justCompleted: false, lang: 'hi', script: 'gurmukhi' }), /ਪੂਰਾ ਨਾਮ/);
  assert.match(signupFollowUp({ name: null, address: 'x', justCompleted: false, lang: 'hi' }), /poora naam/);
});
