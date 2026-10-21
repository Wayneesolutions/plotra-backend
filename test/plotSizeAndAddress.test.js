const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlotSize, sizeMatches, filterBySize } = require('../src/services/buyerSearchService');
const { isDifferentProperty } = require('../src/utils/addressMatch');

test('plot sizes convert to square yards across units', () => {
  assert.equal(parsePlotSize('200 gaj'), 200);
  assert.equal(parsePlotSize('250 Sq Yards'), 250);
  assert.equal(parsePlotSize('1800 sq ft'), 200);
  assert.equal(parsePlotSize('10 marla'), 302.5);
  assert.equal(parsePlotSize('3 bhk'), null);
});

test('buyer size filter keeps matches, then unknowns, and drops other sizes', () => {
  const rows = [{ id: 1, plot_area: '300 gaj' }, { id: 2, plot_area: null }, { id: 3, plot_area: '205 Sq Yards' }, { id: 4, plot_area: '200 gaj' }];
  assert.deepEqual(filterBySize(rows, '200 gaj').map((r) => r.id), [3, 4, 2]);
  assert.deepEqual(filterBySize(rows, '3 bhk').map((r) => r.id), [1, 2, 3, 4]);
  assert.equal(sizeMatches('200 gaj', '400 gaj'), 'mismatch');
});

test('same address reordered or longer is the same property; different number or place is not', () => {
  assert.equal(isDifferentProperty({ raw_address: 'Main Market, Ram Nagar, Ludhiana, Punjab 141003' }, { raw_address: 'Ram Nagar Main Market Ludhiana' }), false);
  assert.equal(isDifferentProperty({ raw_address: 'Ludhiana' }, { raw_address: 'Model Town, Ludhiana' }), false);
  assert.equal(isDifferentProperty({ raw_address: 'Sector 62 Mohali' }, { raw_address: 'Sector 45 Mohali' }), true);
  assert.equal(isDifferentProperty({ raw_address: 'Sarabha Nagar Ludhiana' }, { raw_address: 'Model Town Ludhiana' }), true);
});
