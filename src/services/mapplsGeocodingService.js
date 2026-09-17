// src/services/mapplsGeocodingService.js
//
// Mappls (MapmyIndia) as a second, India-focused geocoding provider —
// used alongside Google (see geoConsensusService.js) specifically for
// house/plot-number level precision, which Mappls' own address index
// tends to resolve better than Google's in tier-2/3 Punjab towns where
// Google's ROOFTOP coverage is thin. Google remains the source of truth
// for locality/area-level resolution (general_area, tenant geo-bias) —
// this module is only ever consulted for the house-level cross-check.
//
// Auth: supports two modes depending on which env vars are set —
//   Static key (MAPPLS_REST_KEY): simplest, use the key directly as a
//     query param. This is the key visible in the Mappls console under
//     Applications → Credentials → Static Key.
//   OAuth2 (MAPPLS_CLIENT_ID + MAPPLS_CLIENT_SECRET): bearer-token flow,
//     used when Client ID/Secret are available instead of a static key.
//   Static key takes precedence if both are set.
//
// Coordinate retrieval: some Mappls account plans return latitude/longitude
// directly in the geocode response; others omit them and return only an
// eLoc (Mappls place ID). When lat/lng are absent, this module makes a
// second call to the Place Details API using the eLoc to fetch coordinates.
const axios = require('axios');

const MAPPLS_TOKEN_URL = 'https://outpost.mappls.com/api/security/oauth/token';
const MAPPLS_GEOCODE_URL = 'https://atlas.mappls.com/api/places/geocode';

// OAuth2 token cache — only used when MAPPLS_REST_KEY is not set.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

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
  cachedTokenExpiresAt = now + (Math.max(Number(expires_in) || 0, 300) - 120) * 1000;
  return cachedToken;
}

/**
 * Geocodes an address against Mappls. Returns a normalized shape
 * (or null if no usable result) rather than the raw Mappls response, so
 * geoConsensusService.js doesn't need to know Mappls' response format.
 *
 * @param {string} address   free-text address (same string sent to Google)
 * @param {string|null} pincode  dealer-provided PIN, passed as itemCount filter hint
 */
async function mapplsGeocode(address, pincode = null) {
  try {
    const restKey = process.env.MAPPLS_REST_KEY;
    const params = { address, region: 'IND', itemCount: 5 };
    if (pincode) params.pincode = pincode;

    let authHeaders;
    if (restKey) {
      // Static key auth — key as query param + Origin header so Mappls'
      // "Web" app domain whitelist accepts the server-side request.
      params.rest_key = restKey;
      authHeaders = {
        Origin: process.env.PUBLIC_APP_URL || 'https://plotraa.com',
        Referer: process.env.PUBLIC_APP_URL || 'https://plotraa.com',
      };
    } else {
      // OAuth2 bearer token auth
      const token = await getMapplsAccessToken();
      authHeaders = { Authorization: `Bearer ${token}` };
    }

    const resp = await axios.get(MAPPLS_GEOCODE_URL, {
      params,
      headers: authHeaders,
      timeout: 8000,
    });

    // Mappls returns copResults as either an array (multiple results) or a
    // plain object (single result) depending on the endpoint/plan. Normalise.
    let results = resp.data?.copResults || resp.data?.results;
    if (results && !Array.isArray(results)) results = [results];
    if (!Array.isArray(results) || !results.length) return null;

    const top = results[0];
    let lat = Number(top.latitude ?? top.lat);
    let lng = Number(top.longitude ?? top.lng);

    // Some Mappls account plans omit lat/lng from the geocode response and
    // return only an eLoc (Mappls place ID). Re-query the geocode endpoint
    // with just the eLoc — this variant of the same endpoint does return
    // coordinates on plans that suppress them from the address-query response.
    if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && top.eLoc) {
      const eLocParams = { eLoc: top.eLoc };
      if (restKey) eLocParams.rest_key = restKey;
      const eLocResp = await axios.get(MAPPLS_GEOCODE_URL, {
        params: eLocParams,
        headers: authHeaders,
        timeout: 8000,
      });
      const eLocTop = eLocResp.data?.copResults?.[0]
        || (eLocResp.data?.copResults && !Array.isArray(eLocResp.data.copResults) ? eLocResp.data.copResults : null)
        || eLocResp.data?.suggestedLocations?.[0]
        || eLocResp.data?.results?.[0];
      if (eLocTop) {
        lat = Number(eLocTop.latitude ?? eLocTop.lat);
        lng = Number(eLocTop.longitude ?? eLocTop.lng);
        console.log('[Mappls eLoc lookup] keys:', Object.keys(eLocTop), 'lat:', eLocTop.latitude, 'lng:', eLocTop.longitude);
      }
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const houseLevelType = new Set(['PREMISE', 'POI', 'SUBSUBLOCALITY', 'STREET']);
    const isHouseLevel = Boolean(top.houseNumber) || houseLevelType.has(String(top.type || '').toUpperCase());

    // 'geocodeLevel' is a Mappls-specific field present on OAuth2/plan responses
    // ('houseNumber', 'street', 'locality', etc.) — treat it as house-level too.
    const mapplsHouseLevels = new Set(['houseNumber', 'poi', 'building', 'premise']);
    const isHouseLevelByGeoLevel = mapplsHouseLevels.has(String(top.geocodeLevel || '').toLowerCase());

    return {
      lat,
      lng,
      formattedAddress: top.formatted_address || top.formattedAddress || null,
      pincode: top.pincode || null,
      eLoc: top.eLoc || null,
      isHouseLevel: isHouseLevel || isHouseLevelByGeoLevel,
      rawType: top.type || top.geocodeLevel || null,
      raw: top,
    };
  } catch (err) {
    // Never throws — Mappls is a cross-check, not a hard dependency.
    console.error('Mappls geocode failed (non-fatal, continuing with Google-only result):', err.message);
    return null;
  }
}

module.exports = { mapplsGeocode, getMapplsAccessToken };
