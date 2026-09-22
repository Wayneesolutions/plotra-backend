// src/services/locationResolutionService.js
//
// Extracted from geoEnrichmentWorker.js so this logic can be shared with
// the manual pin-correction endpoint (publicListingController.js) without
// that plain Express handler importing the worker file itself — which
// would execute `new Worker(...)` as a module-load side effect and start
// a second live consumer of the 'geo-enrichment' queue inside the API
// server process. Queue *producers* (what this file creates) are safe to
// instantiate from multiple processes; Worker *consumers* are not.
const { Queue } = require('bullmq');
const axios = require('axios');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redisConnection = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null };

const landmarkQueue = new Queue('landmark-extraction', { connection: redisConnection });
const localIntelligenceQueue = new Queue('local-intelligence', { connection: redisConnection });

/**
 * Derives a locality-level area string ("Ferozepur Road, Ludhiana") from a
 * Geocoding API result — no house/plot number, no street address, safe to
 * show a buyer before they've contacted the dealer. Shared by
 * geoEnrichmentWorker.js (new listings) and adminGeoReviewController.js
 * (manual pin correction) so both populate listings.general_area the same
 * way — see the marketplace search flow in webhookController.js /
 * buyerSearchService.js for how it's used.
 *
 * Prefers Google's own address_components (accurate, structured) when
 * available. Falls back to trimming the raw formatted_address string when
 * components aren't available (e.g. geoEnrichmentWorker.js's
 * resolved-locality cache-hit path, which skips the fresh geocode call
 * entirely) — good enough for a locality-level label, not relied on for
 * anything precision-sensitive.
 */
function extractGeneralArea(addressComponents, formattedAddress) {
  if (Array.isArray(addressComponents) && addressComponents.length) {
    const findByType = (type) => addressComponents.find((c) => c.types.includes(type))?.long_name;
    const areaPart = findByType('sublocality_level_1') || findByType('sublocality') || findByType('neighborhood') || findByType('route');
    const cityPart = findByType('locality') || findByType('administrative_area_level_2');
    const parts = [areaPart, cityPart].filter(Boolean);
    if (parts.length) return parts.join(', ');
  }

  if (formattedAddress) {
    const segments = formattedAddress.split(',').map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) return segments.slice(1, 4).join(', ');
    return segments[0] || null;
  }

  return null;
}

/**
 * Initial great-circle bearing (degrees, 0-360, 0=north) from point 1 to
 * point 2 — the standard forward-azimuth formula.
 */
function calculateBearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Bug fix: the static Street View URL previously had no `heading` param at
 * all, so Google defaults to whatever direction that camera happened to be
 * facing when Google's car drove past — frequently pointing across or into
 * the plot instead of showing the property from the street. The actual
 * camera position (a point on the nearest road Street View has coverage
 * for) is USUALLY NOT the same as the property's own lat/lng — it's
 * wherever the road is, which can be tens of meters away. Calling the free
 * Street View Metadata endpoint first gets that real camera position, then
 * the bearing FROM there TO the property's lat/lng is the heading that
 * actually points the camera at the property, not just "some" heading.
 * Returns null (never throws) on any failure — the caller falls back to
 * the no-heading URL exactly like before this fix, same degrade-gracefully
 * convention as every other geo lookup in this codebase.
 */
async function getStreetViewHeading(lat, lng, apiKey) {
  try {
    const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${apiKey}`;
    const response = await axios.get(metaUrl, { timeout: 8000 });
    if (response.data?.status !== 'OK' || !response.data?.location) return null;

    const { lat: panoLat, lng: panoLng } = response.data.location;
    if (typeof panoLat !== 'number' || typeof panoLng !== 'number') return null;

    return Math.round(calculateBearing(panoLat, panoLng, lat, lng));
  } catch (err) {
    console.error('Street View metadata/heading lookup failed (non-fatal, using default angle):', err.message);
    return null;
  }
}

/**
 * Persists resolved lat/lng (+ optionally formatted_address and any other
 * listing fields via extraListingUpdates) for a listing, regenerates the
 * static satellite/street-view fallback images (used for WhatsApp/OG
 * preview crawlers, which can't render the interactive JS map), and
 * re-queues landmark + local-intelligence enrichment for the new
 * coordinates — same downstream effect whether the coordinates came from
 * Google's Geocoding API (geoEnrichmentWorker.js) or a dealer manually
 * dragging the pin pre-approval (publicListingController.js).
 */
async function applyResolvedLocation(knex, {
  listingId,
  lat,
  lng,
  formattedAddress,
  targetApiKey,
  propertyType,
  extraListingUpdates = {},
}) {
  // Network call before the transaction opens, not inside it — same
  // don't-hold-a-DB-transaction-across-an-external-API-round-trip
  // convention used throughout this codebase (see e.g.
  // agentIntakeController.js's handleAgentIntakeMessage).
  const streetViewHeading = await getStreetViewHeading(lat, lng, targetApiKey);

  await knex.transaction(async (trx) => {
    const updates = { lat, lng, updated_at: knex.fn.now(), ...extraListingUpdates };
    if (formattedAddress) updates.formatted_address = formattedAddress;

    await trx('listings').where({ id: listingId }).update(updates);

    const staticSatelliteUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=18&size=800x450&maptype=satellite&key=${targetApiKey}`;
    const headingParam = streetViewHeading != null ? `&heading=${streetViewHeading}` : '';
    const staticStreetViewUrl = `https://maps.googleapis.com/maps/api/streetview?size=800x450&location=${lat},${lng}${headingParam}&key=${targetApiKey}`;

    await trx('listing_media')
      .insert({
        id: knex.raw('uuid_generate_v4()'),
        listing_id: listingId,
        satellite_image_url: staticSatelliteUrl,
        streetview_image_url: staticStreetViewUrl,
        fetched_at: knex.fn.now(),
      })
      .onConflict('listing_id')
      .merge();
  });

  await landmarkQueue.add('extract-infra-landmarks', { listingId, lat, lng }, {
    attempts: 2,
    backoff: 1000,
  });

  // Only re-run if we actually have a (possibly updated) formatted address
  // to research against — a manual pin drag without a successful reverse
  // geocode shouldn't kick off local-intelligence research against stale
  // address text.
  if (formattedAddress) {
    await localIntelligenceQueue.add('generate', {
      listingId,
      formattedAddress,
      propertyType,
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
    });
  }
}

module.exports = { applyResolvedLocation, extractGeneralArea };
