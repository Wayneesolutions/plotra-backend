// src/services/mapplsGeocodingService.js
//
// Mappls (MapmyIndia) as a second, India-focused geocoding provider —
// used alongside Google (see geoConsensusService.js) specifically for
// house/plot-number level precision, which Mappls' own address index
// tends to resolve better than Google's in tier-2/3 Punjab towns where
// Google's ROOFTOP coverage is thin. Google remains the source of truth
// for locality/area-level resolution (general_area, tenant geo-bias) —
// this module is only ever consulted for the house-level cross-check.
const axios = require('axios');

const MAPPLS_TOKEN_URL = 'https://outpost.mappls.com/api/security/oauth/token';
const MAPPLS_GEOCODE_URL = 'https://atlas.mappls.com/api/places/geocode';

// Module-level in-memory cache — one access token per process, refreshed
// ~2 min before actual expiry so an in-flight request never races an
// expired token. Deliberately NOT persisted anywhere (Redis, DB): losing
// it on a worker restart just costs one extra token call, which is cheap
// and avoids a second source of stale-credential bugs.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Client-credentials OAuth2 flow — same shape Mappls' own SDKs use.
 * MAPPLS_CLIENT_ID / MAPPLS_CLIENT_SECRET come from the Mappls API
 * Console (separate from any consumer Mappls app credentials).
 */
async function getMapplsAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.MAPPLS_CLIENT_ID;
  const clientSecret = process.env.MAPPLS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('MAPPLS_CLIENT_ID / MAPPLS_CLIENT_SECRET not configured.');
  }

  const resp = await axios.post(
    MAPPLS_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { timeout: 8000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { access_token, expires_in } = resp.data;
  if (!access_token) {
    throw new Error('Mappls token response missing access_token.');
  }

  cachedToken = access_token;
  // expires_in is seconds; refresh 2 minutes early.
  cachedTokenExpiresAt = now + (Math.max(Number(expires_in) || 0, 300) - 120) * 1000;
  return cachedToken;
}

/**
 * Geocodes an address against Mappls. Returns a normalized shape
 * (or null if no usable result) rather than the raw Mappls response, so
 * geoConsensusService.js doesn't need to know Mappls' response format.
 *
 * `isHouseLevel` mirrors what Google's `location_type: ROOFTOP` tells us —
 * true when Mappls' own result carries a resolved house/premise number,
 * i.e. this candidate is precise enough to prefer over a locality-level
 * Google pin. NOTE: field names below (houseNumber/type) are per Mappls'
 * public Geocoding API docs as of integration time — confirm against a
 * live response with the production key before relying on this in prod;
 * a raw-response sample is logged on every call for the first rollout
 * week specifically so this can be calibrated (see geoConsensusService.js).
 *
 * @param {string} address   free-text address (same string sent to Google)
 * @param {string|null} pincode  dealer-provided PIN, passed as itemCount filter hint
 */
async function mapplsGeocode(address, pincode = null) {
  try {
    const token = await getMapplsAccessToken();
    const params = { address, region: 'IND', itemCount: 5 };
    if (pincode) params.pincode = pincode;

    const resp = await axios.get(MAPPLS_GEOCODE_URL, {
      params,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });

    const results = resp.data?.copResults || resp.data?.results;
    if (!Array.isArray(results) || !results.length) return null;

    const top = results[0];
    const lat = Number(top.latitude ?? top.lat);
    const lng = Number(top.longitude ?? top.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const houseLevelType = new Set(['PREMISE', 'POI', 'SUBSUBLOCALITY', 'STREET']);
    const isHouseLevel = Boolean(top.houseNumber) || houseLevelType.has(String(top.type || '').toUpperCase());

    return {
      lat,
      lng,
      formattedAddress: top.formatted_address || top.formattedAddress || null,
      pincode: top.pincode || null,
      eLoc: top.eLoc || null,
      isHouseLevel,
      rawType: top.type || null,
      raw: top, // kept for the calibration log in geoConsensusService.js; never persisted to the DB
    };
  } catch (err) {
    // Never throws — Mappls is a cross-check, not a hard dependency. A
    // failure here (quota, key not provisioned yet, network) must fall
    // back to Google-only behavior exactly like before this integration.
    console.error('Mappls geocode failed (non-fatal, continuing with Google-only result):', err.message);
    return null;
  }
}

module.exports = { mapplsGeocode, getMapplsAccessToken };
