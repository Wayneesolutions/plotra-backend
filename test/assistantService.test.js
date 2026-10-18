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
