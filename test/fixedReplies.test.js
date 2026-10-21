const test = require('node:test');
const assert = require('node:assert');
const {
  replyMatchesScript, isShortDiscountQuestion, discountSummary, hardCapReply,
  paymentProblemReply, supportConfirmLine, mentionsTeamContact, sellerConfirmReply,
} = require('../src/utils/fixedReplies');
const { capShortReply, languageInstruction } = require('../src/services/assistantService');
const { looksLikePaymentProblem } = require('../src/utils/agentQuickIntent');

const PLANS = [{ discount_percent: 40 }, { discount_percent: 40 }, { discount_percent: 30 }, { discount_percent: 0 }];

test('bug 4: reply script must match the latest message', () => {
  assert.equal(replyMatchesScript('Abhi plans pe 40% off hai.', 'roman'), true);
  assert.equal(replyMatchesScript('ਇਸ ਵੇਲੇ 40% ਛੋਟ ਹੈ।', 'roman'), false);
  assert.equal(replyMatchesScript('ਇਸ ਵੇਲੇ 40% ਛੋਟ ਹੈ।', 'gurmukhi'), true);
  assert.equal(replyMatchesScript('Abhi 40% off hai', 'gurmukhi'), false);
  assert.equal(replyMatchesScript('अभी 40% छूट है', 'devanagari'), true);
});

test('bug 4: the language line says to ignore the earlier chat script', () => {
  assert.match(languageInstruction('hi', 'roman'), /Do NOT use Gurmukhi/);
  assert.match(languageInstruction('en', 'roman'), /English only/);
  assert.match(languageInstruction(null, 'gurmukhi'), /Gurmukhi/);
  assert.match(languageInstruction(null, 'roman'), /Roman script only/);
});

test('bug 5: bare discount questions get the fixed reply', () => {
  for (const q of ['Discount?', 'discount', 'koi offer hai?', 'Discount milega kya', 'ਛੋਟ ਮਿਲੇਗੀ?', 'छूट है?']) {
    assert.equal(isShortDiscountQuestion(q), true, q);
  }
  assert.equal(isShortDiscountQuestion('payment ho gaya discount wala plan active nahi hua'), false);
  assert.equal(isShortDiscountQuestion('free trial hai?'), false);
  assert.equal(isShortDiscountQuestion('plan kya hai'), false);
});

test('bug 5: fixed discount reply is 2 short lines in the right script', () => {
  const roman = discountSummary(PLANS, { script: 'roman', lang: 'hi' });
  assert.equal(roman.split('\n').length, 2);
  assert.ok(roman.length < 200);
  assert.match(roman, /30% se 40%/);
  assert.equal(replyMatchesScript(roman, 'roman'), true);
  assert.match(discountSummary(PLANS, { script: 'roman', lang: 'en' }), /30% to 40% off/);
  const pa = discountSummary(PLANS, { script: 'gurmukhi' });
  assert.equal(replyMatchesScript(pa, 'gurmukhi'), true);
  assert.match(discountSummary([{ discount_percent: 40 }], { lang: 'hi' }), /sabhi plans pe 40% off/);
  assert.match(discountSummary([], { lang: 'hi' }), /koi alag discount nahi/);
});

test('bug 5: hard cap cuts one long sentence too', () => {
  const oneSentence = `Basic ₹4,999 40% off Multi User Basic ₹9,999 40% off AI Calling ₹14,999 40% off ${'aur bhi plan details '.repeat(20)}`;
  const out = capShortReply(oneSentence, 'Discount?');
  assert.ok(out.length <= 251, String(out.length));
  assert.ok(out.endsWith('…'));
  const manyLines = 'Line one.\nLine two.\nLine three.\nLine four.';
  assert.equal(hardCapReply(manyLines).split('\n').length, 2);
  assert.equal(capShortReply(manyLines, 'plan kya hai'), manyLines);
});

test('bug 6: owner gets "details received, verified dealer will contact" and the sell link, never listing steps', () => {
  const r = sellerConfirmReply({ property_type: 'Plot', locality: 'Dugri', expected_price: '80 lakh' }, { lang: 'hi', sellLink: 'https://plotraa.com/sell-property' });
  assert.match(r, /Details mil gayi/);
  assert.match(r, /verified dealer/);
  assert.match(r, /\/sell-property/);
  assert.doesNotMatch(r, /listing/i);
  const ask = sellerConfirmReply({ property_type: 'Plot' }, { lang: 'hi' });
  assert.match(ask, /area\/city, expected price/);
  assert.match(sellerConfirmReply(null, { lang: 'en' }), /Thank you/);
  assert.equal(replyMatchesScript(sellerConfirmReply({ city: 'Ludhiana' }, { script: 'gurmukhi', sellLink: 'https://plotraa.com/sell-property' }), 'gurmukhi'), true);
});

test('bug 7: payment problem is detected and confirmed clearly', () => {
  assert.equal(looksLikePaymentProblem('payment ho gaya, plan activate nahi hua'), true);
  assert.match(paymentProblemReply({ lang: 'hi' }), /Team ko bata diya hai, wo jaldi/);
  assert.match(paymentProblemReply({ lang: 'en' }), /informed the Plotraa team/);
  assert.equal(replyMatchesScript(paymentProblemReply({ script: 'gurmukhi' }), 'gurmukhi'), true);
  assert.equal(mentionsTeamContact(paymentProblemReply({ lang: 'hi' })), true);
  assert.equal(mentionsTeamContact('Aapka plan Basic hai.'), false);
  assert.match(supportConfirmLine({ lang: 'hi' }), /Team ko bata diya hai/);
});
