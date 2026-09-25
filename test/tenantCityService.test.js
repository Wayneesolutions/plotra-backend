const test = require('node:test');
const assert = require('node:assert');
const {
  suggestCityCode, normalizeCityCode, formatTenantCode, pickCityMatch, textMentionsCity,
} = require('../src/services/tenantCityService');

const LDH = { id: 1, name: 'Ludhiana' };
const ASR = { id: 2, name: 'Amritsar' };
const auto = (conf = 0.95) => ({ decision: 'auto', localityId: 10, confidence: conf });
const confirm = (conf = 0.7) => ({ decision: 'confirm', localityId: 11, confidence: conf });
const none = { decision: 'unmatched', localityId: null, confidence: 0 };

test('suggestCityCode: first letter + consonants', () => {
  assert.strictEqual(suggestCityCode('Ludhiana'), 'LDH');
  assert.strictEqual(suggestCityCode('Amritsar'), 'AMR');
  assert.strictEqual(suggestCityCode('Una'), 'UNA');
  assert.strictEqual(suggestCityCode(''), 'CTY');
});

test('normalizeCityCode: 2-4 letters, uppercased', () => {
  assert.strictEqual(normalizeCityCode(' ldh '), 'LDH');
  assert.strictEqual(normalizeCityCode('AB'), 'AB');
  assert.strictEqual(normalizeCityCode('LD1'), null);
  assert.strictEqual(normalizeCityCode('LUDHI'), null);
  assert.strictEqual(normalizeCityCode(''), null);
});

test('formatTenantCode pads to 3 digits', () => {
  assert.strictEqual(formatTenantCode('LDH', 2), 'LDH-002');
  assert.strictEqual(formatTenantCode('ASR', 1234), 'ASR-1234');
});

test('textMentionsCity: whole word, case-insensitive', () => {
  assert.strictEqual(textMentionsCity('Hno 5, Ranjit Avenue, AMRITSAR', 'Amritsar'), true);
  assert.strictEqual(textMentionsCity('Ludhianawala road', 'Ludhiana'), false);
});

test('pickCityMatch: auto match in one city beats no match in primary', () => {
  const r = pickCityMatch([{ city: LDH, match: none }, { city: ASR, match: auto() }], 'Hno 5 Ranjit Avenue');
  assert.strictEqual(r.city.id, 2);
});

test('pickCityMatch: auto beats confirm', () => {
  const r = pickCityMatch([{ city: LDH, match: confirm(0.8) }, { city: ASR, match: auto(0.9) }], 'x');
  assert.strictEqual(r.city.id, 2);
});

test('pickCityMatch: tie broken by city named in the address', () => {
  const r = pickCityMatch([{ city: LDH, match: auto() }, { city: ASR, match: auto() }], 'Model Town, Amritsar');
  assert.strictEqual(r.city.id, 2);
});

test('pickCityMatch: no match anywhere -> city named in text, else first (primary)', () => {
  assert.strictEqual(pickCityMatch([{ city: LDH, match: none }, { city: ASR, match: none }], 'plot near bus stand amritsar').city.id, 2);
  assert.strictEqual(pickCityMatch([{ city: LDH, match: none }, { city: ASR, match: none }], 'plot near bus stand').city.id, 1);
});

test('pickCityMatch: empty candidates -> null', () => {
  assert.strictEqual(pickCityMatch([], 'x'), null);
});
