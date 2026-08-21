// src/services/geoBiasService.js
//
// Auto-derives tenant_configs.geo_bias_bounds from a tenant's
// operating_city/operating_state at onboarding time (see
// adminController.js's createTenant/approveRequest) — an admin shouldn't
// have to know Google's bounds format or hand-craft a bounding box for
// every new tenant; they just enter the city the agency operates in.
const axios = require('axios');

/**
 * Returns a Google Geocoding API bounds string ("south,west|north,east")
 * for the given city/state, or null if it can't be resolved (missing city,
 * no API key configured, geocoding fails, or the result has no usable
 * bounds/viewport). Never throws — a failure here should never block
 * tenant onboarding; the tenant just ends up with no geo bias configured,
 * same graceful-degradation behavior geoEnrichmentWorker.js already has
 * for a tenant with none set.
 */
async function resolveCityBounds(city, state) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !city) return null;

  const query = state ? `${city}, ${state}, India` : `${city}, India`;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:IN&key=${apiKey}`;

  try {
    const response = await axios.get(url, { timeout: 8000 });
    if (response.data.status !== 'OK' || !response.data.results.length) return null;

    const geometry = response.data.results[0].geometry;
    // `bounds` (a tight box around the actual city/locality) is only
    // present on some result types — `viewport` is always present on a
    // successful geocode and is a reasonable display-bounds box, so it's
    // a fine fallback for this purpose (a soft ranking bias, not a strict
    // filter — doesn't need to be pixel-perfect).
    const box = geometry.bounds || geometry.viewport;
    if (!box) return null;

    const { southwest, northeast } = box;
    return `${southwest.lat},${southwest.lng}|${northeast.lat},${northeast.lng}`;
  } catch (err) {
    console.error('resolveCityBounds failed (non-fatal — tenant proceeds with no geo bias):', err.message);
    return null;
  }
}

module.exports = { resolveCityBounds };
