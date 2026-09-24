// src/services/geoReviewDecision.js
//
// Pure decision helpers for geoEnrichmentWorker.js — kept out of the worker
// file (which opens Redis/BullMQ connections on require) so they can be
// unit-tested directly. See test/geoReviewDecision.test.js.

// Locality kinds too coarse to vouch for a house-level pin on their own: a
// road is a long corridor (a pin at "Ferozepur Road"'s centroid says nothing
// about which stretch the property is on) and a town is a 3km+ blob.
const COARSE_LOCALITY_KINDS = ['road', 'town'];

/**
 * Builds the text sent to Google. The GPT extraction step moves a named
 * building / mall / shop / society OUT of raw_address into building_name
 * ("Burger King dugri main market" -> building_name "Burger King",
 * raw_address "Dugri Main Market, Ludhiana"), but geocoding only ever saw
 * raw_address — so the single most findable part of the address was
 * silently dropped. Put it back in front, unless it's already in there.
 */
function buildGeocodeQuery(address, buildingName) {
  const addr = (address || '').trim();
  const bn = (buildingName || '').trim();
  if (!bn) return addr;
  if (!addr) return bn;
  if (addr.toLowerCase().includes(bn.toLowerCase())) return addr;
  return `${bn}, ${addr}`;
}

/**
 * True when the Locality Master independently agrees with where the pin
 * landed: the address TEXT confidently names a curated, human-verified
 * area (decision 'auto'), and the geocoded pin sits inside or just at the
 * edge of that same area. That is enough to send the agent a preview (with
 * the usual "check / drag the pin" nudge) instead of parking the listing
 * and asking for a WhatsApp location share — Google almost never returns
 * PREMISE/ROOFTOP for Indian "Hno 203, B Block" style addresses, even when
 * its pin is in exactly the right colony.
 *
 * @param {object|null} localityResult  localityMatcher.match(...) result WITH lat/lng
 * @param {string|null} localityKind    kind of the matched locality row
 */
function isLocalityCorroborated(localityResult, localityKind) {
  if (!localityResult || localityResult.decision !== 'auto' || !localityResult.localityId) return false;
  const pin = localityResult.pin;
  if (!pin || !['inside', 'near'].includes(pin.verdict)) return false;
  if (!pin.coordsVerified) return false;
  if (COARSE_LOCALITY_KINDS.includes(localityKind)) return false;
  return true;
}

/**
 * Whether a WhatsApp-intake listing gets parked in pending_geo_review (no
 * preview; agent asked to share a GPS pin / super-admin must release it).
 */
function shouldParkForGeoReview({ draftId, googleIsHighPrecision, placesMatched, localityCorroborated }) {
  return !!draftId && !googleIsHighPrecision && !placesMatched && !localityCorroborated;
}

module.exports = {
  COARSE_LOCALITY_KINDS,
  buildGeocodeQuery,
  isLocalityCorroborated,
  shouldParkForGeoReview,
};
