// src/services/geoConsensusService.js
//
// Automatic (no human step) cross-validation between Google's geocode
// result and Mappls'. Division of labor, per Pankaj (Sep 2026):
//   - Google: area/locality-level resolution — general_area, tenant
//     geo-bias, satellite/street-view imagery all keep coming from it.
//   - Mappls: house/plot-number level precision — used to *tighten* the
//     final pin when it lands in the same neighbourhood Google already
//     found, never to move the pin somewhere Google didn't corroborate.
//
// This does not add a manual review step. The existing dealer/agent
// pin-drag on the listing preview (publicListingController.js /
// agentIntakeWorker.js's preview message) remains the only human-in-the-
// loop path, unchanged — it's a self-serve part of the approval flow,
// not an ops review queue, and this feature doesn't touch it. What this
// changes is upstream of that: more listings should arrive at the
// preview already precisely pinned, and `location_low_confidence` (which
// drives the "please check the pin" nudge in that preview message) should
// fire only when it's actually warranted.
const { mapplsGeocode } = require('./mapplsGeocodingService');

// Meters. If Mappls' candidate lands further than this from Google's own
// result, the two providers disagree about which neighbourhood the
// address is even in — Mappls is discarded rather than trusted, same
// caution as the existing MAX_CANDIDATE_DRIFT_METERS check on the Places
// fallback in geoEnrichmentWorker.js.
const MAX_AGREEMENT_DRIFT_METERS = 400;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @param {object} googleResult  { lat, lng, isHighPrecision, lowConfidence }
 *   `lat`/`lng` is whatever geoEnrichmentWorker.js already resolved (Address
 *   Validation, Geocoding, Places fallback, or the resolved-locality cache
 *   hit) — this function never re-derives it, only cross-checks it.
 * @param {string} rawAddress   original agent-typed address text
 * @param {string|null} pincode dealer-provided PIN, if any
 *
 * @returns {{
 *   lat: number, lng: number,               // final coordinates to persist
 *   lowConfidence: boolean,                 // final flag to persist
 *   geoResolutionSource: string,            // 'google' | 'mappls_refined' | 'google_only_no_mappls'
 *   mappls: { lat, lng, agreementMeters, isHouseLevel } | null,  // for the new audit columns
 * }}
 */
async function resolveWithConsensus(googleResult, rawAddress, pincode) {
  const { lat: gLat, lng: gLng, isHighPrecision, lowConfidence: googleLowConfidence } = googleResult;

  const mapplsResult = await mapplsGeocode(rawAddress, pincode);

  if (!mapplsResult || mapplsResult.coordsUnavailable) {
    // Mappls unavailable/failed/no match, or returned metadata without
    // coordinates (eLoc-only plan response) — Google-only behavior.
    return {
      lat: gLat,
      lng: gLng,
      lowConfidence: googleLowConfidence,
      geoResolutionSource: mapplsResult?.coordsUnavailable
        ? 'google_only_mappls_no_coords'
        : 'google_only_no_mappls',
      mappls: mapplsResult ? { eLoc: mapplsResult.eLoc, coordsUnavailable: true } : null,
    };
  }

  const agreementMeters = haversineMeters(gLat, gLng, mapplsResult.lat, mapplsResult.lng);
  const providersAgree = agreementMeters <= MAX_AGREEMENT_DRIFT_METERS;

  const mapplsAudit = {
    lat: mapplsResult.lat,
    lng: mapplsResult.lng,
    agreementMeters: Math.round(agreementMeters),
    isHouseLevel: mapplsResult.isHouseLevel,
  };

  if (!providersAgree) {
    // Same neighbourhood-mismatch situation the Places-candidate drift
    // check already guards against — trust Google (whatever precision it
    // already achieved), keep Mappls purely as an audit trail, and leave
    // the existing low-confidence signal as Google computed it. This is
    // the one case genuinely worth a human glance, and it already gets
    // one: the dealer/agent sees the pin on the preview map before
    // approving, same as every listing.
    return {
      lat: gLat,
      lng: gLng,
      lowConfidence: googleLowConfidence,
      geoResolutionSource: 'google',
      mappls: mapplsAudit,
    };
  }

  // Providers agree on neighbourhood. If Mappls additionally resolved a
  // house/plot number and Google's own result didn't reach that precision
  // (i.e. Google needed the Places fallback, or Address Validation flagged
  // it low-confidence), prefer Mappls' tighter pin and clear the
  // low-confidence flag — this is the actual accuracy win this feature is
  // for. If Google was already high-precision, keep Google's pin
  // (no reason to swap a confirmed-good pin) but the agreement itself is
  // still a positive confidence signal, so it can clear a borderline
  // Google low-confidence flag too.
  const shouldPreferMapplsPin = mapplsResult.isHouseLevel && !isHighPrecision;

  return {
    lat: shouldPreferMapplsPin ? mapplsResult.lat : gLat,
    lng: shouldPreferMapplsPin ? mapplsResult.lng : gLng,
    lowConfidence: false,
    geoResolutionSource: shouldPreferMapplsPin ? 'mappls_refined' : 'google',
    mappls: mapplsAudit,
  };
}

module.exports = { resolveWithConsensus, haversineMeters, MAX_AGREEMENT_DRIFT_METERS };
