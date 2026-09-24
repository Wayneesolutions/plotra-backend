const test = require('node:test');
const assert = require('node:assert');
const { buildGeocodeQuery, isLocalityCorroborated, isWeakLocation } = require('../src/services/geoReviewDecision');
const { checkPin } = require('../src/services/locality/geoCheck');

// Real rows / geocoder output from production, 2026-09-24 WhatsApp tests.
const AGGAR_NAGAR = { id: 42, kind: 'area', status: 'active', center_lat: 30.893296, center_lng: 75.794073, radius_m: 800, boundary: null };
const DUGRI_UE_PH2 = { id: 109, kind: 'sector', status: 'active', center_lat: 30.8678, center_lng: 75.8345, radius_m: 500, boundary: null };
const DUGRI = { id: 40, kind: 'area', status: 'active', center_lat: 30.85907, center_lng: 75.84468, radius_m: 1200, boundary: null };
const FEROZEPUR_ROAD = { id: 80, kind: 'road', status: 'active', center_lat: 30.89323, center_lng: 75.80652, radius_m: 1500, boundary: null };

function autoMatch(loc, lat, lng) {
  return { decision: 'auto', localityId: loc.id, name: 'x', pin: checkPin(loc, lat, lng) };
}

test('buildGeocodeQuery: puts building_name back in front of the address', () => {
  assert.strictEqual(buildGeocodeQuery('Dugri Main Market, Ludhiana', 'Burger King'), 'Burger King, Dugri Main Market, Ludhiana');
});

test('buildGeocodeQuery: no duplicate when already present (case-insensitive)', () => {
  assert.strictEqual(buildGeocodeQuery('Wave Malls, Ferozepur Road, Ludhiana', 'wave malls'), 'Wave Malls, Ferozepur Road, Ludhiana');
});

test('buildGeocodeQuery: handles missing parts', () => {
  assert.strictEqual(buildGeocodeQuery('Model Town, Ludhiana', null), 'Model Town, Ludhiana');
  assert.strictEqual(buildGeocodeQuery('', 'DLF One'), 'DLF One');
});

test('corroborated: "Hno 203 Agar Nagar B Block" — pin ~870m from centre (near edge)', () => {
  assert.strictEqual(isLocalityCorroborated(autoMatch(AGGAR_NAGAR, 30.88827, 75.80106), 'area'), true);
});

test('corroborated: "Hno 1130 Sugri Phase 2" — pin at Dugri UE Ph 2 centre', () => {
  assert.strictEqual(isLocalityCorroborated(autoMatch(DUGRI_UE_PH2, 30.86778, 75.83451), 'sector'), true);
});

test('corroborated: "Burger King Dugri main market" — pin on Dugri Rd, inside Dugri tolerance', () => {
  assert.strictEqual(isLocalityCorroborated(autoMatch(DUGRI, 30.87532, 75.84488), 'area'), true);
});

test('NOT corroborated: pin far outside the named area', () => {
  // Ludhiana city centroid (what Address Validation returned for the Solitaire Homes address)
  assert.strictEqual(isLocalityCorroborated(autoMatch(AGGAR_NAGAR, 30.9010, 75.8573), 'area'), false);
});

test('NOT corroborated: road-kind locality is too coarse on its own', () => {
  assert.strictEqual(isLocalityCorroborated(autoMatch(FEROZEPUR_ROAD, 30.89323, 75.80652), 'road'), false);
});

test('NOT corroborated: unverified locality coords', () => {
  const unverified = { ...AGGAR_NAGAR, status: 'needs_review' };
  assert.strictEqual(isLocalityCorroborated(autoMatch(unverified, 30.8933, 75.7941), 'area'), false);
});

test('NOT corroborated: text match only at confirm level, or no match', () => {
  assert.strictEqual(isLocalityCorroborated({ ...autoMatch(AGGAR_NAGAR, 30.8933, 75.7941), decision: 'confirm' }, 'area'), false);
  assert.strictEqual(isLocalityCorroborated({ decision: 'unmatched', localityId: null }, null), false);
  assert.strictEqual(isLocalityCorroborated(null, null), false);
});

test('isWeakLocation: truth table', () => {
  const base = { googleIsHighPrecision: false, placesMatched: false, localityCorroborated: false };
  assert.strictEqual(isWeakLocation(base), true);
  assert.strictEqual(isWeakLocation({ ...base, localityCorroborated: true }), false);
  assert.strictEqual(isWeakLocation({ ...base, placesMatched: true }), false);
  assert.strictEqual(isWeakLocation({ ...base, googleIsHighPrecision: true }), false);
});
