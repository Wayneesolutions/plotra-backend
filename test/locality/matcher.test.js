const test = require('node:test');
const assert = require('node:assert');
const seed = require('../../data/ludhiana_localities.json');
const { normalize, extractPincode } = require('../../src/services/locality/normalize');
const { buildIndex, matchText } = require('../../src/services/locality/matcherCore');
const { checkPin, localitiesForPoint } = require('../../src/services/locality/geoCheck');
const { parseReply } = require('../../src/services/locality/llmResolver');

// Build an in-memory index from the seed (ids = position, parents resolved by name)
const locs = seed.localities.map((l, i) => ({ id: i + 1, ...l }));
for (const l of locs) l.parent_id = l.parent ? locs.find((p) => p.name === l.parent).id : null;
const index = buildIndex(locs);
const idOf = (name) => locs.find((l) => l.name === name).id;
const m = (t) => matchText(index, t);

test('normalize handles dealer shorthand', () => {
  assert.strictEqual(normalize('Dugri Ph-II, Ldh'), 'dugri phase 2');
  assert.strictEqual(normalize('sec-32A chd rd'), 'sector 32a chd road');
  assert.strictEqual(normalize('Model Town Extn.'), 'model town extension');
  assert.strictEqual(normalize('ਦੁੱਗਰੀ, ਲੁਧਿਆਣਾ'), 'ਦੁੱਗਰੀ');
  assert.strictEqual(extractPincode('H no 12 dugri 141013'), '141013');
});

const cases = [
  ['200 gaj plot dugri ph-2 mein', 'Dugri Phase 2', 'auto'],
  ['Dugri Phase II, Ludhiana 141013', 'Dugri Phase 2', 'auto'],
  ['3bhk kothi urban estate dugri phase 1', 'Dugri Phase 1', 'auto'],
  ['kothi in dugri', 'Dugri', 'auto'],
  ['H.No 45, Sarabha Nagar, Pakhowal Road', 'Sarabha Nagar', 'auto'],
  ['plot near sarabha nagar, pakhowal road', 'Pakhowal Road', 'auto'],
  ['flat model town extn', 'Model Town Extension', 'auto'],
  ['kothi model town', 'Model Town', 'auto'],
  ['sarabah nagr 250 gaj', 'Sarabha Nagar', null], // typo -> fuzzy
  ['ਸਰਾਭਾ ਨਗਰ ਵਿੱਚ ਕੋਠੀ', 'Sarabha Nagar', 'auto'],
  ['बीआरएस नगर', null, 'unmatched'], // Devanagari not in aliases -> goes to LLM in real flow
  ['bhai randhir singh nagar I block', 'BRS Nagar', 'auto'],
  ['sks nagar pakhowal rd', 'Shaheed Karnail Singh Nagar', 'auto'],
  ['firozpur road plot', 'Ferozepur Road', 'auto'],
  ['random village xyz', null, 'unmatched'],
];

for (const [text, expected, decision] of cases) {
  test(`match: ${text}`, () => {
    const r = m(text);
    if (expected === null) {
      assert.strictEqual(r.decision, 'unmatched', JSON.stringify(r.best));
    } else {
      assert.ok(r.best, 'no match');
      assert.strictEqual(r.best.name, expected, `got ${r.best.name} (${r.best.method} ${r.best.score})`);
      if (decision) assert.strictEqual(r.decision, decision);
    }
  });
}

test('phase numbers are never fuzzed into each other', () => {
  const r = m('dugri phase 4');
  // must NOT become phase 2/3; parent Dugri is fine
  assert.strictEqual(r.best.name, 'Dugri');
});

test('typo match does not auto-accept blindly', () => {
  const r = m('sarabah nagr 250 gaj');
  assert.strictEqual(r.best.method, 'fuzzy');
  assert.ok(['auto', 'confirm'].includes(r.decision));
});

test('geo check: inside / near / outside', () => {
  const loc = { center_lat: 30.8870, center_lng: 75.8200, radius_m: 1000, status: 'active' };
  assert.strictEqual(checkPin(loc, 30.8875, 75.8205).verdict, 'inside');
  assert.strictEqual(checkPin(loc, 30.8870, 75.8350).verdict, 'near'); // ~1.4 km
  assert.strictEqual(checkPin(loc, 30.9500, 75.8200).verdict, 'outside');
  assert.strictEqual(checkPin({ ...loc, center_lat: null }, 30.9, 75.8).verdict, 'unknown');
});

test('geo check: polygon takes priority over radius', () => {
  const loc = {
    center_lat: 30.0, center_lng: 75.0, radius_m: 100000, status: 'active',
    boundary: { type: 'Polygon', coordinates: [[[75, 30], [75.01, 30], [75.01, 30.01], [75, 30.01], [75, 30]]] },
  };
  assert.strictEqual(checkPin(loc, 30.005, 75.005).verdict, 'inside');
});

test('pin suggestions prefer areas over road corridors', () => {
  const rows = [
    { id: 1, name: 'Pakhowal Road', kind: 'road', center_lat: 30.88, center_lng: 75.83, radius_m: 3000, status: 'active' },
    { id: 2, name: 'Sarabha Nagar', kind: 'area', center_lat: 30.884, center_lng: 75.828, radius_m: 1000, status: 'active' },
  ];
  const s = localitiesForPoint(rows, 30.8842, 75.8281);
  assert.strictEqual(s[0].name, 'Sarabha Nagar');
});

test('LLM reply parsing rejects invented ids', () => {
  const allowed = new Set([1, 2, 3]);
  assert.strictEqual(parseReply('{"locality_id": 99, "confidence": 0.9}', allowed), null);
  const ok = parseReply('sure! {"locality_id": 2, "confidence": 0.99, "matched_phrase": "brs ngr"}', allowed);
  assert.strictEqual(ok.localityId, 2);
  assert.strictEqual(ok.confidence, 0.9); // capped
});
