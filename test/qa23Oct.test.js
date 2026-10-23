// 23 Oct QA fixes: trial date blocks listings at once, no cash option,
// buyer search budget / formatting, builder profile switched off.
const test = require('node:test');
const assert = require('node:assert');

const trial = require('../src/services/trialService');
const search = require('../src/services/buyerSearchService');
const { MESSAGES } = require('../src/utils/i18n');
const { PRODUCT } = require('../src/assistant/plotraaKnowledge');
const { formatInrShort } = require('../src/utils/money');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-31T10:00:00+05:30');

test('trial over = no new listing, even while the flag is still on (cron not run yet)', () => {
  const ended = { trial_ends_at: new Date(now.getTime() - 60 * 1000), can_add_listing: true };
  assert.strictEqual(trial.listingAllowed(ended, { now }), false);
  const running = { trial_ends_at: new Date(now.getTime() + DAY), can_add_listing: true };
  assert.strictEqual(trial.listingAllowed(running, { now }), true);
  assert.strictEqual(trial.listingAllowed({ ...ended }, { now, hasApprovedPayment: true }), true, 'paid dealer keeps listing');
  assert.strictEqual(trial.listingAllowed({ trial_ends_at: null, can_add_listing: false }, { now }), false);
  assert.strictEqual(trial.listingAllowed({ trial_ends_at: null, can_add_listing: true }, { now }), true);
});

test('dealerIsActive / canAddNewListing read the trial date, not only the flag', async () => {
  const rows = {
    users: [{ id: 'u1', tenant_id: 't1', role: 'owner', trial_ends_at: new Date(now.getTime() - 1000), can_add_listing: true, created_at: now }],
    payment_submissions: [],
  };
  // Tiny knex stand-in: where(obj).orderBy().first() over the rows above.
  const knex = (table) => {
    let list = rows[table];
    const q = {
      where(obj) { list = list.filter((r) => Object.entries(obj).every(([k, v]) => r[k] === v)); return q; },
      orderBy() { return q; },
      first() { return Promise.resolve(list[0]); },
    };
    return q;
  };
  assert.strictEqual(await trial.dealerIsActive(knex, 't1', now), false);
  assert.strictEqual(await trial.canAddNewListing(knex, rows.users[0], now), false);
  rows.users[0].trial_ends_at = new Date(now.getTime() + DAY);
  assert.strictEqual(await trial.dealerIsActive(knex, 't1', now), true);
  assert.strictEqual(await trial.canAddNewListing(knex, rows.users[0], now), true);
});

test('no cash option anywhere a dealer reads it', () => {
  for (const key of ['plan_selected_link', 'plan_selected_qr', 'plan_pay_receipt', 'agent_help']) {
    for (const [v, text] of Object.entries(MESSAGES[key])) {
      assert.ok(!/cash|ਕੈਸ਼|कैश/i.test(text), `${key}.${v} mentions cash`);
    }
  }
  assert.ok(!/pay cash|can pay cash|or pay cash/i.test(PRODUCT));
  assert.match(PRODUCT, /NO cash payment option/);
});

test('prices read as lakh / crore', () => {
  assert.strictEqual(formatInrShort(5000000), '₹50 lakh');
  assert.strictEqual(formatInrShort(27000000), '₹2.7 crore');
  assert.strictEqual(formatInrShort(12500000), '₹1.25 crore');
  assert.strictEqual(formatInrShort(85000), '₹85,000');
  assert.strictEqual(search.formatPrice(null), 'Price on request');
});

test('search results: sizes cleaned, area never contradicts the title, price-on-request after priced', () => {
  assert.strictEqual(search.displaySize('100 PLYORD SQ'), null);
  assert.strictEqual(search.displaySize('250 Sq Yards'), '250 sq yd');
  assert.strictEqual(search.displaySize('10 Marla'), '10 marla');
  assert.strictEqual(search.displayArea({ title: 'Plot in Dasmesh Nagar', general_area: 'Industrial Area-B, Ludhiana' }), 'Dasmesh Nagar');
  assert.strictEqual(search.displayArea({ title: 'Plot in Dugri', general_area: 'Dugri, Ludhiana' }), 'Dugri, Ludhiana');
  assert.strictEqual(search.displayArea({ title: 'x', general_area: 'Y', locality_name: 'Dasmesh Nagar', locality_city: 'Ludhiana' }), 'Dasmesh Nagar, Ludhiana');

  const reply = search.formatSearchReply([
    { title: 'On request', price: null, plot_area: null, general_area: 'Dugri', public_slug: 'b' },
    { title: 'Priced', price: 5000000, plot_area: '200 gaj', general_area: 'Dugri', public_slug: 'a' },
  ], {});
  assert.match(reply, /1\. \*Priced\* — ₹50 lakh · 200 gaj/);
  assert.match(reply, /\*Price on request:\*\n\n2\. \*On request\*/);
  assert.ok(!/50,00,000/.test(reply));
});

test('several property types are matched together; kothi finds villa and house', () => {
  assert.deepStrictEqual(search.expandTypes(['Plot', 'Villa']), ['plot', 'villa', 'house']);
});

test('builder profile stays off unless switched on', async () => {
  delete process.env.BUILDER_PROFILE_PUBLIC;
  delete process.env.BUILDER_AUTO_PUBLISH;
  const ctrl = require('../src/controllers/builderProfileController');
  let status = null;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  await ctrl.getPublicBuilderProfile({ params: { slug: 'x' }, app: { get: () => () => { throw new Error('db must not be queried'); } } }, res);
  assert.strictEqual(status, 404);
  assert.strictEqual(await ctrl.autoPublishIfReady(() => { throw new Error('no db'); }, { builderProfileId: 1 }), false);
});
