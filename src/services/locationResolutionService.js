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

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redisConnection = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null };

const landmarkQueue = new Queue('landmark-extraction', { connection: redisConnection });
const localIntelligenceQueue = new Queue('local-intelligence', { connection: redisConnection });

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
  await knex.transaction(async (trx) => {
    const updates = { lat, lng, updated_at: knex.fn.now(), ...extraListingUpdates };
    if (formattedAddress) updates.formatted_address = formattedAddress;

    await trx('listings').where({ id: listingId }).update(updates);

    const staticSatelliteUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=18&size=800x450&maptype=satellite&key=${targetApiKey}`;
    const staticStreetViewUrl = `https://maps.googleapis.com/maps/api/streetview?size=800x450&location=${lat},${lng}&key=${targetApiKey}`;

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

module.exports = { applyResolvedLocation };
