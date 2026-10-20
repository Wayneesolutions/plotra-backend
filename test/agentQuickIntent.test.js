const test = require('node:test');
const assert = require('node:assert/strict');
const { quickAgentIntent } = require('../src/utils/agentQuickIntent');
const { isVocabularyOnly, cleanTranscript } = require('../src/services/voiceNoteService');

test('a plain address goes to listing intake, never to support', () => {
  assert.equal(quickAgentIntent('Main Market, Ram Nagar, Ludhiana, Punjab 141003', { draftOpen: true }), 'listing_info');
  assert.equal(quickAgentIntent('Plot 5, Sarabha Nagar, Ludhiana', { draftOpen: true }), 'listing_info');
});

test('payment made but plan not active is a support issue', () => {
  assert.equal(quickAgentIntent('payment ho gaya but plan activate nahi hua'), 'support');
  assert.equal(quickAgentIntent('I paid but my plan is not active'), 'support');
});

test('common agent questions are answered by the assistant', () => {
  for (const t of ['Discount?', 'support number kya hai', 'plan upgrade karna hai', 'dashboard login kaise karu', 'voice note bhej sakta hu?', 'ਡੈਸ਼ਬੋਰਡ ਲੌਗਿਨ ਕਿਵੇਂ ਕਰਾਂ']) {
    assert.equal(quickAgentIntent(t, { draftOpen: true }), 'question', t);
  }
});

test('listing details are left alone', () => {
  assert.equal(quickAgentIntent('200 gaj plot Dugri 1.2 crore'), null);
  assert.equal(quickAgentIntent('price 55 lakh karo discount included'), null);
});

test('voice: prompt-vocabulary-only transcripts are rejected, real ones kept', () => {
  assert.equal(isVocabularyOnly('Plot in Sarabha Nagar'.replace('Sarabha Nagar', 'flat kothi'), 4), true);
  assert.equal(cleanTranscript('Plot flat kothi', { durationSec: 6 }), null);
  assert.equal(cleanTranscript('Dugri mein 200 gaj plot hai 1.2 crore', { durationSec: 6 }), 'Dugri mein 200 gaj plot hai 1.2 crore');
});
