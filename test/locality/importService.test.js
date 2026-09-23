const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, csvRowsToInputs, validateRow, CSV_COLUMNS } = require('../../src/services/locality/importService');

test('parseCsv: basic rows', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n4,5,6');
  assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
});

test('parseCsv: quoted field with embedded comma and escaped quote', () => {
  const rows = parseCsv('name,note\n"Dugri, Phase 2","she said ""hi"""\n');
  assert.deepStrictEqual(rows, [['name', 'note'], ['Dugri, Phase 2', 'she said "hi"']]);
});

test('parseCsv: CRLF line endings', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n');
  assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('csvRowsToInputs: maps header to fields regardless of column order', () => {
  const rows = parseCsv('aliases,name,kind\n"dugri 2;dugri ph 2",Dugri Phase 2,area\n');
  const inputs = csvRowsToInputs(rows);
  assert.strictEqual(inputs.length, 1);
  assert.strictEqual(inputs[0].name, 'Dugri Phase 2');
  assert.strictEqual(inputs[0].kind, 'area');
  assert.deepStrictEqual(inputs[0].aliases, ['dugri 2', 'dugri ph 2']);
  assert.strictEqual(inputs[0].center_lat, null);
});

test('csvRowsToInputs: matches the documented CSV_COLUMNS header', () => {
  const header = CSV_COLUMNS.join(',');
  const rows = parseCsv(`${header}\nSarabha Nagar,area,,141001,30.884,75.828,1000,\n`);
  const [input] = csvRowsToInputs(rows);
  assert.strictEqual(input.center_lat, 30.884);
  assert.strictEqual(input.pincode, '141001');
});

const LUDHIANA = { name: 'Ludhiana', center_lat: 30.9010, center_lng: 75.8573, bounds_radius_km: 25 };

test('validateRow: accepts a valid in-bounds row', () => {
  const errors = validateRow({ name: 'Sarabha Nagar', center_lat: 30.884, center_lng: 75.828, radius_m: 1000 }, LUDHIANA);
  assert.deepStrictEqual(errors, []);
});

test('validateRow: requires a name', () => {
  const errors = validateRow({ name: '', center_lat: null, center_lng: null, radius_m: null }, LUDHIANA);
  assert.ok(errors.some((e) => /name/.test(e)));
});

test('validateRow: rejects coordinates outside India', () => {
  const errors = validateRow({ name: 'Somewhere', center_lat: 51.5, center_lng: -0.12, radius_m: null }, LUDHIANA); // London
  assert.ok(errors.some((e) => /center_lat out of range/.test(e)));
});

test('validateRow: rejects a centre far outside the city bounds', () => {
  // Chandigarh-ish coordinates, ~30km+ from Ludhiana centre
  const errors = validateRow({ name: 'Too Far', center_lat: 30.74, center_lng: 76.79, radius_m: null }, LUDHIANA);
  assert.ok(errors.some((e) => /centre is .*km from/.test(e)));
});

test('validateRow: rejects radius outside 200-5000m', () => {
  const tooSmall = validateRow({ name: 'X', center_lat: 30.884, center_lng: 75.828, radius_m: 50 }, LUDHIANA);
  const tooBig = validateRow({ name: 'X', center_lat: 30.884, center_lng: 75.828, radius_m: 9000 }, LUDHIANA);
  assert.ok(tooSmall.some((e) => /radius_m must be/.test(e)));
  assert.ok(tooBig.some((e) => /radius_m must be/.test(e)));
});

test('validateRow: no coordinates yet is not an error (needs_review, not rejected)', () => {
  const errors = validateRow({ name: 'No Coords Yet', center_lat: null, center_lng: null, radius_m: null }, LUDHIANA);
  assert.deepStrictEqual(errors, []);
});
