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

    let requestConfig;
    if (restKey) {
      // Static key auth — key as query param + Origin header so Mappls'
      // "Web" app domain whitelist accepts the server-side request.
      params.rest_key = restKey;
      requestConfig = {
        params,
        timeout: 8000,
        headers: {
          Origin: process.env.PUBLIC_APP_URL || 'https://plotraa.com',
          Referer: process.env.PUBLIC_APP_URL || 'https://plotraa.com',
        },
      };
    } else {
      // OAuth2 bearer token auth
      const token = await getMapplsAccessToken();
      requestConfig = {
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000,
      };
    }

    const resp = await axios.get(MAPPLS_GEOCODE_URL, requestConfig);

    console.log('[Mappls Debug] status:', resp.status, 'data keys:', Object.keys(resp.data || {}), 'raw:', JSON.stringify(resp.data).slice(0, 600));

    // Mappls returns copResults as either an array (multiple results) or a
    // plain object (single result) depending on the endpoint/plan. Normalise.
    let results = resp.data?.copResults || resp.data?.results;
    if (results && !Array.isArray(results)) results = [results];
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
      raw: top,
    };
  } catch (err) {
    // Never throws — Mappls is a cross-check, not a hard dependency.
    console.error('Mappls geocode failed (non-fatal, continuing with Google-only result):', err.message);
    return null;
  }
}

module.exports = { mapplsGeocode, getMapplsAccessToken };
