const test = require('node:test');
const assert = require('node:assert/strict');
const { decideRoute, parseClassification, pickListingCandidates, buttonTitle } = require('../src/services/agentIntentService');

const idle = { draftStatus: null, draftHasContent: false };
const midDraft = { draftStatus: 'collecting', draftHasContent: true };
const awaiting = { draftStatus: 'awaiting_approval', draftHasContent: true };
const c = (intent, confidence, listingHint = null) => ({ intent, confidence, listingHint });

test('no classification (LLM down / flag off) always falls back to intake', () => {
  assert.deepEqual(decideRoute(null, idle), { route: 'intake' });
  assert.deepEqual(decideRoute(null, awaiting), { route: 'intake' });
});

test('listing info always goes to intake', () => {
  assert.deepEqual(decideRoute(c('listing_info', 0.99), midDraft), { route: 'intake' });
});

test('approval is only forced when a preview is waiting and confidence is high', () => {
  assert.deepEqual(decideRoute(c('approve', 0.95), awaiting), { route: 'intake', forceApproval: true });
  assert.deepEqual(decideRoute(c('approve', 0.7), awaiting), { route: 'intake' });
  assert.deepEqual(decideRoute(c('approve', 0.99), midDraft), { route: 'intake' });
  assert.deepEqual(decideRoute(c('approve', 0.99), idle), { route: 'intake' });
});

test('new listing intent is passed through to intake', () => {
  assert.deepEqual(decideRoute(c('new_listing', 0.9), awaiting), { route: 'intake', forceNewListing: true });
  assert.deepEqual(decideRoute(c('new_listing', 0.3), awaiting), { route: 'intake' });
});

test('non-listing intents route away when confident', () => {
  assert.deepEqual(decideRoute(c('my_listings', 0.7), idle), { route: 'my_listings' });
  assert.deepEqual(decideRoute(c('mark_sold', 0.9), idle), { route: 'mark_sold' });
  assert.deepEqual(decideRoute(c('plan_info', 0.8), idle), { route: 'plan_info' });
  assert.deepEqual(decideRoute(c('help', 0.65), idle), { route: 'help' });
});

test('mid-draft needs higher confidence before leaving intake', () => {
  assert.deepEqual(decideRoute(c('my_listings', 0.7), midDraft), { route: 'intake' });
  assert.deepEqual(decideRoute(c('my_listings', 0.85), midDraft), { route: 'my_listings' });
});

test('greeting / other do not hijack a listing in progress', () => {
  assert.deepEqual(decideRoute(c('greeting', 0.99), midDraft), { route: 'intake' });
  assert.deepEqual(decideRoute(c('other', 0.99), midDraft), { route: 'intake' });
  assert.deepEqual(decideRoute(c('greeting', 0.9), idle), { route: 'greeting' });
  assert.deepEqual(decideRoute(c('other', 0.9), idle), { route: 'help' });
});

test('parseClassification rejects junk and clamps confidence', () => {
  assert.equal(parseClassification('not json'), null);
  assert.equal(parseClassification('{"intent":"fly"}'), null);
  assert.deepEqual(parseClassification('{"intent":"help","confidence":3}'), { intent: 'help', confidence: 1, listingHint: null, replyLanguage: null });
  assert.deepEqual(parseClassification({ intent: 'mark_sold', confidence: 0.8, listing_hint: ' model town ', reply_language: 'hi' }), { intent: 'mark_sold', confidence: 0.8, listingHint: 'model town', replyLanguage: 'hi' });
});

const listings = [
  { id: 'a', title: 'Plot in Model Town', raw_address: 'Model Town Extension, Ludhiana', general_area: 'Model Town', property_type: 'Plot', plot_area: '200 gaj' },
  { id: 'b', title: 'Kothi in Dugri', raw_address: 'Phase 2 Dugri, Ludhiana', general_area: 'Dugri', property_type: 'Villa', plot_area: '10 marla' },
  { id: 'c', title: 'Shop in Sarabha Nagar', raw_address: 'Sarabha Nagar Market', general_area: 'Sarabha Nagar', property_type: 'Commercial', plot_area: null },
];

test('pickListingCandidates matches by words, ignoring filler like "wala"', () => {
  assert.deepEqual(pickListingCandidates(listings, 'model town wala plot').map((l) => l.id), ['a']);
  assert.deepEqual(pickListingCandidates(listings, 'dugri kothi').map((l) => l.id), ['b']);
});

test('pickListingCandidates supports list numbers', () => {
  assert.deepEqual(pickListingCandidates(listings, '2').map((l) => l.id), ['b']);
  assert.deepEqual(pickListingCandidates(listings, '3rd').map((l) => l.id), ['c']);
  assert.deepEqual(pickListingCandidates(listings, '9'), []);
});

test('pickListingCandidates with no hint only auto-picks a single listing', () => {
  assert.deepEqual(pickListingCandidates(listings, null), []);
  assert.deepEqual(pickListingCandidates([listings[0]], null).map((l) => l.id), ['a']);
  assert.deepEqual(pickListingCandidates(listings, 'xyz unknown'), []);
});

test('buttonTitle respects the 20-char WhatsApp limit', () => {
  assert.equal(buttonTitle('Short'), 'Short');
  assert.equal(buttonTitle('Shop in Sarabha Nagar Market').length, 20);
});
