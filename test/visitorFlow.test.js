const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/utils/visitorFlowParsers');
const M = require('../src/services/visitorFlowMachine');
const { t, MESSAGES } = require('../src/utils/i18n');

// Runs a list of messages through the machine, returning the state after each
// and the reply keys / effect names it asked for.
function run(messages, { start = null, ctx = {} } = {}) {
  let state = start;
  const trace = [];
  for (const text of messages) {
    const r = M.decide(state, text, ctx);
    state = r.state;
    trace.push({ text, role: state.role, step: state.step, data: state.data, v: r.v, keys: r.out.map((o) => (o.type === 'reply' ? o.key : `@${o.name}`)), out: r.out });
  }
  return { state, trace };
}
const keys = (trace, i) => trace[i].keys;

test('first message always gets the role menu (no guessing), whatever it says', () => {
  for (const first of ['hi', 'Dugri mein 200 gaj plot', 'plots in Ludhiana', 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ', 'kya haal hai']) {
    const { trace } = run([first]);
    assert.deepStrictEqual(keys(trace, 0), ['role_menu'], first);
    assert.strictEqual(trace[0].step, 'role');
  }
});

test('stating the role outright skips the menu: that is not a guess', () => {
  assert.strictEqual(run(['main dealer hoon']).state.role, 'dealer');
  assert.strictEqual(run(['join']).state.role, 'dealer');
  // 23 Oct: selling gets the sell-property link, not the owner questions.
  assert.deepStrictEqual(keys(run(['meri kothi bechni hai 1.5 crore']).trace, 0), ['sell_link']);
  assert.strictEqual(run(['main owner hoon']).state.role, 'owner');
});

test('menu numbers pick the role; a wrong reply re-asks; a question is answered and the menu re-asked', () => {
  assert.strictEqual(run(['hi', '1']).state.role, 'buyer');
  assert.strictEqual(run(['hi', '2']).state.role, 'dealer');
  assert.strictEqual(run(['hi', '3']).state.role, 'dealer', 'old menu number still means dealer');
  assert.strictEqual(run(['hi', 'owner']).state.role, 'owner', 'owner path stays reachable when typed');
  assert.deepStrictEqual(keys(run(['hi', 'abc']).trace, 1), ['role_retry']);
  assert.deepStrictEqual(keys(run(['hi', 'support number kya hai?']).trace, 1), ['@assistant', 'role_retry']);
});

test('owner flow asks type, size, location, price, photos one at a time', () => {
  const { trace, state } = run(['hi', 'owner', '1', '200 gaj', 'Dugri, Ludhiana', '80 lakh', 'done']);
  assert.deepStrictEqual(trace.map((x) => x.step), ['role', 'type', 'size', 'location', 'price', 'photos', 'done']);
  assert.strictEqual(state.data.type, 'Plot');
  assert.strictEqual(state.data.size, '200 gaj');
  assert.strictEqual(state.data.locality, 'Dugri');
  assert.strictEqual(state.data.city, 'Ludhiana');
  assert.strictEqual(state.data.price_text, '₹80 lakh');
  assert.ok(keys(trace, 6).includes('owner_done'));
  assert.ok(keys(trace, 6).includes('@seller_lead_sync'));
});

test('details in the first message are not asked again', () => {
  const { trace } = run(['hi'], {});
  const first = run(['main owner hoon, Dugri mein 200 gaj plot hai 80 lakh']);
  assert.strictEqual(first.state.role, 'owner');
  assert.strictEqual(first.state.step, 'location', 'type, size and price already given');
  assert.ok(trace);
});

test('bug A: after the sale is saved, hi / plan questions are not answered with the owner confirmation', () => {
  const done = run(['hi', 'owner', '1', '200 gaj', 'Dugri, Ludhiana', '80 lakh', 'skip']).state;
  const hello = M.decide(done, 'hello');
  assert.deepStrictEqual(hello.out.map((o) => o.key), ['owner_after_done']);
  assert.notStrictEqual(hello.out[0].key, 'owner_done');
  const plan = M.decide(done, 'plan');
  assert.deepStrictEqual(plan.out.map((o) => o.name || o.key), ['plans']);
  const q = M.decide(done, 'mera plan kab tak chalega?');
  assert.deepStrictEqual(q.out.map((o) => o.name || o.key), ['assistant']);
});

test('bug E: an owner can still join as a dealer ("join", "main dealer hoon")', () => {
  const owner = run(['hi', 'owner', '1', '200 gaj', 'Dugri, Ludhiana', '80 lakh', 'skip']).state;
  for (const msg of ['join', 'main dealer hoon', 'mujhe join karna hai', 'judna hai']) {
    const r = M.decide(owner, msg);
    assert.strictEqual(r.state.role, 'dealer', msg);
    assert.strictEqual(r.state.step, 'name', msg);
    assert.ok(r.out.some((o) => o.key === 'role_set_dealer'));
  }
  // and from the middle of the owner flow
  const mid = run(['hi', 'owner', '1']).state;
  assert.strictEqual(M.decide(mid, 'main dealer hoon').state.role, 'dealer');
});

test('"menu" changes the role at any time, in any step', () => {
  for (const state of [run(['hi', 'owner', '1']).state, run(['hi', '1']).state, run(['hi', '3']).state]) {
    const r = M.decide(state, 'menu');
    assert.strictEqual(r.state.role, null);
    assert.deepStrictEqual(r.out.map((o) => o.key), ['role_menu']);
  }
  assert.strictEqual(M.decide(null, 'menu').state.role, null);
});

test('dealer flow: name, area, then the request is sent with trial and payment explained', () => {
  const { trace, state } = run(['hi', '3', 'Rajesh Kumar', 'Model Town, Ludhiana']);
  assert.deepStrictEqual(trace.map((x) => x.step), ['role', 'name', 'area', 'done']);
  assert.ok(trace[1].out[0].then.key === 'dealer_ask_name');
  const submit = trace[3].out.find((o) => o.name === 'dealer_submit');
  assert.strictEqual(submit.dealerName, 'Rajesh Kumar');
  assert.strictEqual(submit.area, 'Model Town, Ludhiana');
  // the texts explain the 7-day trial and the payment after it
  assert.match(t('dealer_ask_name', 'hi', { days: 7 }), /7 din ka free trial[\s\S]*payment/i);
  assert.match(t('dealer_submitted', 'hi', { name: 'R', area: 'L', days: 7 }), /7 din ka free trial[\s\S]*payment link ya QR/);
  assert.strictEqual(state.role, 'dealer');
});

test('restating the role in the middle ("main dealer hoon" at the name step) is not taken as the name', () => {
  const s = run(['hi', '3']).state;
  const r = M.decide(s, 'main dealer hoon');
  assert.strictEqual(r.state.step, 'name');
  assert.strictEqual(r.state.data.name, undefined);
});

test('buyer flow asks budget, area, type, size, then searches', () => {
  const { trace } = run(['hi', '1', '50 lakh', 'Dugri, Ludhiana', '1', '200 gaj']);
  assert.deepStrictEqual(trace.map((x) => x.step), ['role', 'budget', 'area', 'type', 'size', 'done']);
  const search = trace[5].out.find((o) => o.name === 'buyer_search');
  assert.strictEqual(search.data.type, 'Plot');
  assert.strictEqual(search.data.budget_inr, 5000000);
  assert.strictEqual(search.data.locality, 'Dugri');
  assert.match(search.summary, /Plot 200 gaj in Dugri, Ludhiana budget ₹50 lakh/);
});

test('skip moves on; two misses stop the loop instead of asking forever', () => {
  const skipped = run(['hi', '1', 'skip', 'skip', 'skip', 'skip']);
  assert.strictEqual(skipped.state.step, 'done');
  const loop = run(['hi', 'owner', '1', 'bahut badi hai', 'pata nahi kitni']); // size: miss, miss -> kept as text
  assert.deepStrictEqual(keys(loop.trace, 3), ['step_retry'], 'first miss asks again');
  assert.notStrictEqual(loop.trace[4].step, 'size', 'second miss moves on');
});

test('a question in a flow is answered, then the same step is asked again', () => {
  const s = run(['hi', 'owner', '1']).state; // at size
  const r = M.decide(s, 'plan kya hai?');
  assert.deepStrictEqual(r.out.map((o) => o.name || o.key), ['plans', 'question_then_step']);
  assert.strictEqual(r.state.step, 'size');
  const q = M.decide(s, 'kya aap meri help kar sakte ho?');
  assert.deepStrictEqual(q.out.map((o) => o.name || o.key), ['assistant', 'question_then_step']);
  assert.strictEqual(q.state.step, 'size');
});

test('bug C: replies follow the script of the message', () => {
  assert.strictEqual(M.decide(null, 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ').v, 'pa');
  assert.strictEqual(M.decide(null, 'नमस्ते').v, 'hi_deva');
  assert.strictEqual(M.decide(null, 'hello there how are you').v, 'en');
  assert.strictEqual(M.decide(null, 'namaste ji kaise ho').v, 'hi');
  // a short reply keeps the last variant
  const pa = M.decide(null, 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ').state;
  assert.strictEqual(M.decide(pa, '2').v, 'pa');
});

test('owner photos: five photos finish the flow', () => {
  let state = run(['hi', 'owner', '1', '200 gaj', 'Dugri, Ludhiana', '80 lakh']).state;
  assert.ok(M.acceptsPhoto(state));
  for (let i = 1; i <= 5; i += 1) {
    const r = M.afterPhoto(state, `https://s3/p${i}.jpg`);
    state = r.state;
    if (i < 5) { assert.strictEqual(state.step, 'photos'); assert.ok(r.out.some((o) => o.key === 'owner_photo_saved')); }
  }
  assert.strictEqual(state.step, 'done');
  assert.strictEqual(state.data.photo_urls.length, 5);
  assert.ok(!M.acceptsPhoto(state));
});

test('a long gap or restart word starts again; "sell" after finishing starts a new property', () => {
  const done = run(['hi', 'owner', '1', '200 gaj', 'Dugri, Ludhiana', '80 lakh', 'skip']).state;
  const again = M.decide(done, 'sell');
  assert.strictEqual(again.state.role, 'owner');
  assert.strictEqual(again.state.step, 'type');
  assert.strictEqual(again.state.data.seller_lead_id, undefined, 'a new lead, not the old one');
});

test('parsers: sizes, prices, types and locations', () => {
  assert.strictEqual(P.parseSize('200 gaj'), '200 gaj');
  assert.strictEqual(P.parseSize('3bhk'), '3 BHK');
  assert.deepStrictEqual(P.parsePrice('1.5 crore'), { text: '₹1.5 crore', inr: 15000000 });
  assert.strictEqual(P.parsePrice('80 lakh').inr, 8000000);
  assert.strictEqual(P.parsePropertyType('kothi'), 'Villa');
  assert.strictEqual(P.parsePropertyType('3'), 'Flat');
  assert.deepStrictEqual(P.splitLocation('Dugri, Ludhiana'), { locality: 'Dugri', city: 'Ludhiana' });
  assert.deepStrictEqual(P.splitLocation('Ludhiana', ['Ludhiana']), { locality: null, city: 'Ludhiana' });
  assert.strictEqual(P.mentionsYearly('yearly pe koi extra benefit?'), true);
  assert.strictEqual(P.mentionsYearly('monthly plan'), false);
  assert.strictEqual(P.isPlanListRequest('plan kya hai'), true);
  assert.strictEqual(P.isPlanListRequest('plan upgrade kaise karun'), false);
});

test('every fixed text exists in all four variants with the same {placeholders}', () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [key, entry] of Object.entries(MESSAGES)) {
    for (const v of ['en', 'hi', 'pa', 'hi_deva']) assert.ok(entry[v] && entry[v].length, `${key}.${v} missing`);
    const base = vars(entry.en);
    for (const v of ['hi', 'pa', 'hi_deva']) assert.strictEqual(vars(entry[v]), base, `${key}.${v} placeholders differ`);
    assert.match(entry.pa, /[਀-੿]/, `${key}.pa should be Gurmukhi`);
    assert.match(entry.hi_deva, /[ऀ-ॿ]/, `${key}.hi_deva should be Devanagari`);
  }
  assert.throws(() => t('no_such_key', 'hi'));
});

test('role menu offers only Buyer and Dealer (no Owner option) in every script', () => {
  for (const v of ['en', 'hi', 'pa', 'hi_deva']) {
    const menu = MESSAGES.role_menu[v];
    assert.ok(!/Owner/.test(menu), `role_menu.${v} must not offer Owner`);
    assert.ok(/1️⃣ Buyer/.test(menu) && /2️⃣ Dealer/.test(menu), `role_menu.${v}`);
    assert.ok(!/3️⃣/.test(menu), `role_menu.${v} has no third option`);
    assert.ok(!/Owner/.test(MESSAGES.role_retry[v]), `role_retry.${v}`);
  }
});

test('23 Oct: "want to sell / bechna hai / vechna hai" gets the sell-property link in any role, never a search', () => {
  for (const msg of ['meri kothi bechni hai Dugri mein', 'want to sell 1.5 crore kothi', 'plot vechna hai', 'bechna hai']) {
    assert.deepStrictEqual(keys(run([msg]).trace, 0), ['sell_link'], msg);
  }
  const buyerDone = run(['hi', '1', '50 lakh', 'Dugri, Ludhiana', '1', '200 gaj']).state;
  const r = run(['want to sell 1.5 crore kothi'], { start: buyerDone });
  assert.deepStrictEqual(keys(r.trace, 0), ['sell_link']);
  assert.strictEqual(r.state.role, 'buyer', 'role is left as it was');
  const midDealer = run(['main dealer hoon']).state;
  assert.deepStrictEqual(keys(run(['kothi bechni hai'], { start: midDealer }).trace, 0), ['sell_link']);
});

test('23 Oct: a bare "2" from the old 3-option menu is not guessed; the new menu is shown again', () => {
  const oldMenuState = { role: null, step: 'role', data: { done: {} } }; // saved before menu_v existed
  const r = run(['2', '2'], { start: oldMenuState });
  assert.deepStrictEqual(keys(r.trace, 0), ['role_menu']);
  assert.strictEqual(r.trace[0].role, null);
  assert.strictEqual(r.state.role, 'dealer', 'after seeing the current menu, 2 = Dealer');
  assert.strictEqual(run(['hi', '2']).state.role, 'dealer');
});

test('23 Oct: buyer can pick several property types ("1, 2, 3")', () => {
  const { trace } = run(['hi', '1', '50 lakh', 'Dugri, Ludhiana', '1, 2, 3', 'skip']);
  assert.strictEqual(trace[4].step, 'size');
  const search = trace[5].out.find((o) => o.name === 'buyer_search');
  assert.deepStrictEqual(search.data.types, ['Plot', 'Villa', 'Flat']);
  assert.deepStrictEqual(P.parsePropertyTypes('1 aur 3'), ['Plot', 'Flat']);
  assert.deepStrictEqual(P.parsePropertyTypes('plot ya flat'), ['Plot', 'Flat']);
});
