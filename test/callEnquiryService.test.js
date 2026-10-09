const test = require('node:test');
const assert = require('node:assert');
const {
  transcriptToText,
  normalizeSpokenIndianMobile,
  resolveWhatsappPhone,
  normalizeExtraction,
  sanitizeTemplateParam,
  describeRequirement,
  buildTemplateJob,
  isAffirmativeReply,
  parsePhoneList,
} = require('../src/services/callEnquiryService');

test('transcriptToText: Vapi message array -> Caller/Agent lines, system/tool turns dropped', () => {
  const text = transcriptToText([
    { role: 'system', message: 'You are Simran…' },
    { role: 'bot', message: 'Namaste, Plotraa se Simran bol rahi hoon.' },
    { role: 'user', message: ' Mujhe Sarabha Nagar mein plot chahiye ' },
    { role: 'tool_calls', message: 'x' },
    { role: 'assistant', content: 'Budget kitna hai?' },
    null,
    { role: 'user' },
  ]);
  assert.strictEqual(text, 'Agent: Namaste, Plotraa se Simran bol rahi hoon.\nCaller: Mujhe Sarabha Nagar mein plot chahiye\nAgent: Budget kitna hai?');
});

test('transcriptToText: plain string passes through; empty shapes give empty string', () => {
  assert.strictEqual(transcriptToText('AI: hello\nUser: hi'), 'AI: hello\nUser: hi');
  assert.strictEqual(transcriptToText([]), '');
  assert.strictEqual(transcriptToText(null), '');
  assert.strictEqual(transcriptToText({ a: 1 }), '');
});

test('normalizeSpokenIndianMobile: accepts well-formed Indian mobiles in common spoken shapes', () => {
  assert.strictEqual(normalizeSpokenIndianMobile('98765 43210'), '+919876543210');
  assert.strictEqual(normalizeSpokenIndianMobile('+91-98765-43210'), '+919876543210');
  assert.strictEqual(normalizeSpokenIndianMobile('919876543210'), '+919876543210');
  assert.strictEqual(normalizeSpokenIndianMobile('09876543210'), '+919876543210');
});

test('normalizeSpokenIndianMobile: rejects anything STT could have mangled', () => {
  assert.strictEqual(normalizeSpokenIndianMobile('987654321'), null);     // digit dropped
  assert.strictEqual(normalizeSpokenIndianMobile('98765432100'), null);   // digit doubled
  assert.strictEqual(normalizeSpokenIndianMobile('5876543210'), null);    // not a mobile series
  assert.strictEqual(normalizeSpokenIndianMobile(''), null);
  assert.strictEqual(normalizeSpokenIndianMobile(null), null);
});

test('resolveWhatsappPhone: a valid spoken number beats caller ID', () => {
  assert.deepStrictEqual(
    resolveWhatsappPhone({ spokenNumber: '9876543210', callerPhone: '+919811111111' }),
    { phone: '+919876543210', source: 'spoken' }
  );
});

test('resolveWhatsappPhone: falls back to caller ID when the spoken number is unusable', () => {
  assert.deepStrictEqual(
    resolveWhatsappPhone({ spokenNumber: '98765', callerPhone: '9811111111' }),
    { phone: '+919811111111', source: 'caller_id' }
  );
});

test('resolveWhatsappPhone: never returns our own forwarding line', () => {
  const excluded = parsePhoneList('+91 83600 98455, 9811111111');
  assert.deepStrictEqual(excluded, ['+918360098455', '+919811111111']);
  assert.deepStrictEqual(
    resolveWhatsappPhone({ spokenNumber: null, callerPhone: '+918360098455', excludedNumbers: excluded }),
    { phone: null, source: null }
  );
  // …but a spoken number still works on a forwarded call
  assert.deepStrictEqual(
    resolveWhatsappPhone({ spokenNumber: '9876543210', callerPhone: '+918360098455', excludedNumbers: excluded }),
    { phone: '+919876543210', source: 'spoken' }
  );
});

test('resolveWhatsappPhone: withheld caller ID and no spoken number -> null', () => {
  assert.deepStrictEqual(resolveWhatsappPhone({ spokenNumber: null, callerPhone: null }), { phone: null, source: null });
  assert.deepStrictEqual(resolveWhatsappPhone({ spokenNumber: null, callerPhone: 'anonymous' }), { phone: null, source: null });
});

test('normalizeExtraction: not an enquiry -> null', () => {
  assert.strictEqual(normalizeExtraction({ is_property_enquiry: false }), null);
  assert.strictEqual(normalizeExtraction({ is_property_enquiry: 'true', area: 'x' }), null);
  assert.strictEqual(normalizeExtraction(null), null);
});

test('normalizeExtraction: canonicalises vocabulary, drops placeholder strings', () => {
  const result = normalizeExtraction({
    is_property_enquiry: true,
    intent: 'BUY',
    property_type: 'plot',
    area: '  Sarabha   Nagar ',
    budget_text: 'not mentioned',
    size_text: '200 gaj',
    timeline_text: 'N/A',
    buyer_name: 'Harpreet',
    whatsapp_number: '9876543210',
    whatsapp_consent: true,
  });
  assert.deepStrictEqual(result, {
    intent: 'buy',
    propertyType: 'Plot',
    area: 'Sarabha Nagar',
    budgetText: null,
    sizeText: '200 gaj',
    timelineText: null,
    buyerName: 'Harpreet',
    spokenWhatsappNumber: '9876543210',
    whatsappConsent: true,
  });
});

test('normalizeExtraction: unknown property type / intent become null rather than a bad filter', () => {
  const result = normalizeExtraction({ is_property_enquiry: true, intent: 'lease-to-own', property_type: 'Penthouse', area: 'Dugri', whatsapp_consent: 'yes' });
  assert.strictEqual(result.intent, null);
  assert.strictEqual(result.propertyType, null);
  assert.strictEqual(result.area, 'Dugri');
  assert.strictEqual(result.whatsappConsent, null);
});

test('sanitizeTemplateParam: no newlines/tabs/space runs, never empty', () => {
  assert.strictEqual(sanitizeTemplateParam('Plot\nin\tSarabha     Nagar', 'x'), 'Plot in Sarabha Nagar');
  assert.strictEqual(sanitizeTemplateParam('', 'there'), 'there');
  assert.strictEqual(sanitizeTemplateParam(null, 'there'), 'there');
  assert.strictEqual(sanitizeTemplateParam(3, '0'), '3');
  assert.strictEqual(sanitizeTemplateParam('a'.repeat(300), 'x').length, 120);
});

test('describeRequirement', () => {
  assert.strictEqual(describeRequirement({ propertyType: 'Plot', area: 'Sarabha Nagar', sizeText: '200 gaj' }), '200 gaj Plot in Sarabha Nagar');
  assert.strictEqual(describeRequirement({ propertyType: null, area: 'Dugri', sizeText: null }), 'property in Dugri');
  assert.strictEqual(describeRequirement({ propertyType: 'Flat', area: null, sizeText: null }), 'Flat');
});

test('buildTemplateJob: null without a configured template; full job with one', () => {
  const previous = process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME;
  delete process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME;
  assert.strictEqual(buildTemplateJob({ enquiryId: 'e1', phone: '+919876543210', matchCount: 2, requirement: 'Plot' }), null);

  process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME = 'call_enquiry_listings';
  const job = buildTemplateJob({ enquiryId: 'e1', tenantId: null, phone: '+919876543210', buyerName: null, matchCount: 2, requirement: 'Plot in Dugri' });
  assert.strictEqual(job.phone, '+919876543210');
  assert.strictEqual(job.tenantId, null);
  assert.strictEqual(job.threadId, undefined); // no thread -> worker must not try to log to whatsapp_messages
  assert.deepStrictEqual(job.template, {
    name: 'call_enquiry_listings',
    lang: 'en',
    bodyParams: ['there', '2', 'Plot in Dugri'],
    quickReplyPayload: 'call_enquiry:e1',
  });

  if (previous === undefined) delete process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME;
  else process.env.WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME = previous;
});

test('isAffirmativeReply: short yes-style replies in English / Hinglish / Hindi / Punjabi', () => {
  for (const text of ['Yes', 'yes please', 'haan ji', 'Haan bhejo', 'ok', 'Show properties', 'dikhao', 'हाँ', 'हां जी', 'ਹਾਂ ਜੀ', 'OK!', 'send']) {
    assert.strictEqual(isAffirmativeReply(text), true, text);
  }
});

test('isAffirmativeReply: a fresh search or anything else falls through to the normal flow', () => {
  for (const text of ['plots in Model Town', 'no', 'nahi chahiye', 'yes but show me flats in Dugri instead', 'join as agent', 'hello', '', null, 'what is the price']) {
    assert.strictEqual(isAffirmativeReply(text), false, String(text));
  }
});
