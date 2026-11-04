const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/utils/listingTypes');
const { formatSearchReply, effectiveListingType, listingAmount } = require('../src/services/buyerSearchService');
const { buildButtons } = require('../src/services/listingStatusCheckService');
const { sellerLeadDetails } = require('../src/controllers/sellerLeadController');

test('first question: dealer replies map to sale / rent / lease', () => {
  const cases = [
    ['1', 'sale'], ['2', 'rent'], ['3', 'lease'], ['3️⃣', 'lease'], ['੨', 'rent'],
    ['Rent', 'rent'], ['kiraye pe dena hai', 'rent'], ['lease', 'lease'], ['bechni hai', 'sale'],
    ['ltype:rent', 'rent'], ['Sell (Bechna)', 'sale'], ['ਕਿਰਾਏ ਤੇ ਦੇਣਾ', 'rent'], ['किराए पे देना है', 'rent'],
  ];
  for (const [text, want] of cases) {
    assert.strictEqual(L.parseListingType(text, { allowNumber: true }), want, text);
    assert.ok(L.isBareListingTypeChoice(text), `${text} is a bare choice`);
  }
});

test('a type said inside a property message counts, but is not a bare choice', () => {
  assert.strictEqual(L.parseListingType('2bhk flat for rent model town 18k'), 'rent');
  assert.strictEqual(L.parseListingType('shop on lease ferozepur road 1.5 lakh'), 'lease');
  assert.strictEqual(L.parseListingType('plot for sale dugri 50 lakh'), 'sale');
  assert.ok(!L.isBareListingTypeChoice('2bhk flat for rent model town 18k'));
  assert.strictEqual(L.parseListingType('2 kanal plot'), null, 'numbers only count at the question');
  assert.strictEqual(L.parseListingType('hello'), null);
});

test('required fields: listing type first, then the type-specific ones', () => {
  assert.deepStrictEqual(L.missingFields(null, {}), ['listing_type', 'title', 'raw_address', 'property_type']);
  const filled = { title: 'x', raw_address: 'y', property_type: 'Flat' };
  assert.deepStrictEqual(L.missingFields('sale', filled), [], 'sale price stays optional');
  assert.deepStrictEqual(L.missingFields('rent', filled), ['monthly_rent']);
  assert.deepStrictEqual(L.missingFields('lease', { ...filled, monthly_rent: 150000 }), []);
});

test('the listing-type question is asked alone, with three buttons', () => {
  const q = L.nextQuestion(['listing_type', 'title', 'raw_address'], null, 'hi');
  assert.match(q.body, /Sell/);
  assert.match(q.body, /Rent/);
  assert.match(q.body, /Lease/);
  assert.doesNotMatch(q.body, /address/i, 'nothing else in the same message');
  assert.strictEqual(q.buttons.length, 3);
  assert.deepStrictEqual(q.buttons.map((b) => b.id), ['ltype:sale', 'ltype:rent', 'ltype:lease']);
  for (const b of q.buttons) assert.ok(b.title.length <= 20, 'WhatsApp button titles max 20 chars');
});

test('follow-up questions use the chosen type\'s wording', () => {
  const rent = L.nextQuestion(['property_type', 'monthly_rent'], 'rent', 'hi').body;
  assert.match(rent, /kiraye/i);
  assert.match(rent, /Room\/PG/);
  assert.match(rent, /per month/);
  const lease = L.nextQuestion(['property_type'], 'lease', 'en').body;
  assert.match(lease, /Warehouse/);
  const sale = L.nextQuestion(['property_type'], 'sale', 'en').body;
  assert.match(sale, /Plot/);
  assert.strictEqual(L.nextQuestion(['raw_address'], 'rent', 'en').buttons, undefined);
});

test('one optional details question for rent / lease, none for sale', () => {
  assert.match(L.detailsQuestion('rent', {}, 'hi'), /deposit/);
  assert.match(L.detailsQuestion('rent', {}, 'en'), /skip/);
  assert.match(L.detailsQuestion('lease', {}, 'en'), /lock-in/);
  assert.strictEqual(L.detailsQuestion('sale', {}, 'en'), null);
  assert.strictEqual(L.detailsQuestion('rent', { security_deposit: 1, furnishing: 'furnished', preferred_tenant: 'family' }, 'en'), null,
    'not asked when the dealer already gave most of it');
});

test('rentalColumns normalises amounts and choices; only given keys come back', () => {
  const cols = L.rentalColumns({
    listing_type: 'Rent', monthly_rent: '18k', security_deposit: '1.5 lakh', furnishing: 'Semi Furnished',
    preferred_tenant: 'Bachelor', rent_escalation_percent: '5%', property_subtype: 'independent floor',
  });
  assert.deepStrictEqual(cols, {
    listing_type: 'rent', monthly_rent: 18000, security_deposit: 150000, furnishing: 'semi-furnished',
    preferred_tenant: 'bachelors', rent_escalation_percent: 5, property_subtype: 'Independent Floor',
  });
  assert.deepStrictEqual(L.rentalColumns({ title: 'x' }), {});
  assert.deepStrictEqual(L.rentalColumnsNonNull({ monthly_rent: null, furnishing: 'furnished' }), { furnishing: 'furnished' });
  assert.strictEqual(L.rentalColumns({ listing_type: 'nonsense' }).listing_type, undefined);
});

test('price line: sale price, or monthly rent + deposit', () => {
  assert.strictEqual(L.formatListingPrice({ price: 5500000 }), '₹55 lakh');
  assert.strictEqual(L.formatListingPrice({ listing_type: 'rent', monthly_rent: 18000, security_deposit: 36000 }), '₹18,000/month + ₹36,000 deposit');
  assert.strictEqual(L.formatListingPrice({ listing_type: 'lease', monthly_rent: 250000 }), '₹2.5 lakh/month');
  assert.strictEqual(L.formatListingPrice({ listing_type: 'rent', price: 5000000 }), null, 'a rental never shows a sale price');
});

test('search: buy/rent from what was said, else guessed from the budget', () => {
  assert.strictEqual(effectiveListingType({ listingType: 'rent' }), 'rent');
  assert.strictEqual(effectiveListingType({ budgetInr: 15000 }), 'rent');
  assert.strictEqual(effectiveListingType({ budgetInr: 5000000 }), 'sale');
  assert.strictEqual(effectiveListingType({}), null, 'nothing said: all types');
  assert.strictEqual(listingAmount({ listing_type: 'rent', monthly_rent: '18000.00', price: null }), 18000);
  assert.strictEqual(listingAmount({ listing_type: 'sale', price: '5000000' }), 5000000);
});

test('search reply labels rentals and shows the monthly rent', () => {
  const reply = formatSearchReply([
    { title: '2BHK Flat in Model Town', listing_type: 'rent', monthly_rent: 18000, security_deposit: 36000, public_slug: 'a', general_area: 'Model Town, Ludhiana' },
    { title: 'Plot in Dugri', listing_type: 'sale', price: 5000000, public_slug: 'b', general_area: 'Dugri, Ludhiana' },
  ], {});
  assert.match(reply, /\[For Rent\] — ₹18,000\/month \+ ₹36,000 deposit/);
  assert.match(reply, /\[For Sale\] — ₹50 lakh/);
  const salesOnly = formatSearchReply([{ title: 'Plot', price: 5000000, public_slug: 'c' }], {});
  assert.doesNotMatch(salesOnly, /\[For Sale\]/, 'all-sale results look exactly as before');
  assert.match(formatSearchReply([], { listingType: 'rent', area: 'Dugri' }), /for rent/);
});

test('30-day check: rentals are asked "rented out?", same sold: button id', () => {
  assert.deepStrictEqual(buildButtons('L1', { listing_type: 'rent' })[1], { id: 'sold:L1', title: 'Rented Out' });
  assert.deepStrictEqual(buildButtons('L1', { listing_type: 'lease' })[1], { id: 'sold:L1', title: 'Leased Out' });
  assert.deepStrictEqual(buildButtons('L1', {})[1], { id: 'sold:L1', title: 'Sold' });
});

test('owner leads can be to rent out or lease out', () => {
  assert.strictEqual(sellerLeadDetails({ listing_type: 'rent', property_type: 'Flat' }), 'Owner renting out: Flat');
  assert.strictEqual(sellerLeadDetails({ listing_type: 'lease' }), 'Owner wants to lease out a property');
  assert.strictEqual(sellerLeadDetails({}), 'Owner wants to sell a property');
});

test('owner wanting to rent OUT gets the owner form; a tenant looking for rent does not', () => {
  const { looksLikeRentOutIntent } = require('../src/utils/sellerIntent');
  const M = require('../src/services/visitorFlowMachine');
  assert.strictEqual(looksLikeRentOutIntent('flat kiraye pe dena hai'), 'rent');
  assert.strictEqual(looksLikeRentOutIntent('shop lease pe deni hai'), 'lease');
  assert.strictEqual(looksLikeRentOutIntent('I want to rent out my shop'), 'rent');
  assert.strictEqual(looksLikeRentOutIntent('flat kiraye pe chahiye'), null);
  assert.strictEqual(looksLikeRentOutIntent('need flat on rent'), null);
  const out = M.decide(null, 'meri kothi kiraye pe deni hai', {}).out;
  assert.deepStrictEqual(out.map((o) => o.key), ['rent_out_link']);
});
