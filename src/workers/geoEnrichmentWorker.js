// src/workers/geoEnrichmentWorker.js
const { Worker, Queue } = require('bullmq');
const axios = require('axios');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { logAgentOutboundMessage, enqueueAgentWhatsappSend } = require('../services/agentMessagingService');
const { applyResolvedLocation } = require('../services/locationResolutionService');
const { lookupResolvedLocality, recordResolvedLocality } = require('../services/resolvedLocalityService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Connect to dedicated background Redis event broker
const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

// Only used for WhatsApp agent-intake listings (job.data.draftId present) —
// see agentIntakeWorker.js's 'send-preview' handler. landmark-extraction
// and local-intelligence queues moved into locationResolutionService.js,
// shared with the manual pin-correction endpoint — no longer declared
// here to avoid a second, redundant Queue connection to the same queues.
const agentIntakeQueue = new Queue('agent-listing-intake', { connection: redisConnection });

console.log(`[Worker Engine] Initializing Geo-Enrichment Task Consumer...`);

const geoWorker = new Worker('geo-enrichment', async (job) => {
  const { listingId, rawAddress, draftId } = job.data;

  console.log(`[Job ${job.id}] Processing Geocoding Blueprint optimization for Listing Ref: ${listingId}`);

  // Fetch the configuration key matching this listing context block to see if an API key override exists
  const listingData = await knex('listings').where({ id: listingId }).first();
  if (!listingData) {
    throw new Error(`Listing ID ${listingId} not found. Terminating job.`);
  }

  const config = await knex('tenant_configs').where({ tenant_id: listingData.tenant_id }).first();
  const targetApiKey = config?.google_maps_api_key_override || process.env.GOOGLE_MAPS_API_KEY;

  if (!targetApiKey) {
    throw new Error('Missing available Google Maps API Access Token.');
  }

  // Soft geographic bias toward wherever THIS tenant actually operates —
  // Google's `bounds` param *influences* ranking without hard-excluding
  // results outside it (unlike `components`, which is a strict filter).
  // Config-driven per tenant (tenant_configs.geo_bias_bounds), not a
  // hardcoded region in code: a single hardcoded bias (e.g. "always
  // Punjab") would help today's 100%-Punjab dealer base but actively hurt
  // accuracy the moment a tenant operates somewhere else — their
  // ambiguous addresses would get quietly tilted toward the wrong
  // region too. See migration 20260821_02 for the full reasoning and how
  // existing tenants got today's Punjab/tricity bounds preserved as their
  // configured value, not lost when this moved out of code.
  //
  // A locality name common across many Indian cities (e.g. "Professor
  // Colony", which exists in multiple states) has nothing steering it
  // toward the dealer's actual market without this — Google's default
  // national ranking just picks whichever match ranks first, which is
  // exactly how a Punjab listing once geocoded to Raipur, Chhattisgarh,
  // ~1,700km away. Every downstream feature that derives from lat/lng
  // (satellite/street view, nearby-landmark search) is consequently wrong
  // too whenever this happens — same root cause, multiple symptoms.
  const geoBiasBounds = config?.geo_bias_bounds || null;

  // pincode (optional, dealer-provided — see listingExtractionService.js)
  // is a much stronger signal than the tenant-level bounds bias: a bounds
  // box biases ranking across a whole city/region, while a PIN code is a
  // strict filter (Google's `components` param is AND logic, not a soft
  // bias like `bounds`) restricting to a small, precise postal area. When
  // present, it supersedes the bounds bias entirely rather than stacking
  // with it — there's nothing left for a region-level bias to add once
  // the search is already pinned to a specific postal code.
  const components = listingData.pincode
    ? `postal_code:${listingData.pincode}|country:IN`
    : 'country:IN';
  const boundsQueryParam = (!listingData.pincode && geoBiasBounds) ? `&bounds=${geoBiasBounds}` : '';

  try {
    // 0. Self-learning cache check — before ever calling Google, see if a
    // human already confirmed a location for this exact building_name or
    // raw_address on a past listing for this tenant (see
    // resolvedLocalityService.js / migration 20260828_04). A hit here is
    // categorically more trustworthy than a fresh Google geocode: it's a
    // coordinate a real person looked at a map and confirmed, not a
    // prominence-ranked guess — and it costs zero API calls. Only the
    // pincode/bounds-biased Google flow below is skipped on a hit; the
    // downstream steps (persist, regenerate satellite/street images,
    // re-queue landmarks) are identical either way.
    const cacheHit = await lookupResolvedLocality(knex, {
      tenantId: listingData.tenant_id,
      buildingName: listingData.building_name,
      rawAddress,
    });

    let lat, lng, formattedAddress;

    if (cacheHit) {
      console.log(`[Job ${job.id}] Resolved-locality cache HIT (${cacheHit.key_type}="${cacheHit.display_name}", confidence=${cacheHit.confidence}) — skipping Google geocode.`);
      lat = Number(cacheHit.lat);
      lng = Number(cacheHit.lng);
      formattedAddress = cacheHit.formatted_address || null;
    } else {
      // 1. Dispatch lookup request directly to Google Geocoding engine
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(rawAddress)}&components=${components}${boundsQueryParam}&key=${targetApiKey}`;
      let response = await axios.get(geoUrl);

      // If the pincode-scoped lookup returned no results, retry without it.
      // A valid locality ("Focal Point, Chandigarh Road, Ludhiana") can get
      // ZERO_RESULTS when the strict postal_code component filter is applied,
      // because Google's index doesn't always associate a specific sub-locality
      // name with the exact PIN even when the area is otherwise geocodable.
      // Falling back to bounds bias (soft, not a hard filter) recovers these
      // cases without widening the search to the whole country.
      if (response.data.status !== 'OK' && listingData.pincode) {
        const fallbackBoundsParam = geoBiasBounds ? `&bounds=${geoBiasBounds}` : '';
        const fallbackUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(rawAddress)}&components=country:IN${fallbackBoundsParam}&key=${targetApiKey}`;
        const fallbackResponse = await axios.get(fallbackUrl);
        if (fallbackResponse.data.status === 'OK') {
          response = fallbackResponse;
        }
      }

      if (response.data.status !== 'OK') {
        throw new Error(`Google Maps Platform rejected lookup parameter with status code: ${response.data.status}`);
      }

      const result = response.data.results[0];
      formattedAddress = result.formatted_address;
      ({ lat, lng } = result.geometry.location);
    }

    // 2-4. Persist lat/lng/formatted_address, regenerate static satellite/
    // street-view fallback images, and re-queue landmark + local-
    // intelligence enrichment — shared with the manual pin-correction
    // endpoint (publicListingController.js) via locationResolutionService.js.
    // Conversational-intake listings (source: 'whatsapp' or 'web') wait for
    // an approval reply in that same conversation before going publicly
    // active — see agentIntakeController.js/agentIntakeWorker.js for
    // WhatsApp, webChatController.js for the web-chat channel. Dashboard-
    // created listings keep the original immediate pending->active
    // behavior, unchanged. Folded into the same transaction via
    // extraListingUpdates rather than a separate statement, so the status
    // flip and the coordinates land atomically together.
    await applyResolvedLocation(knex, {
      listingId,
      lat,
      lng,
      formattedAddress,
      targetApiKey,
      propertyType: listingData.property_type,
      extraListingUpdates: {
        status: ['whatsapp', 'web'].includes(listingData.source) ? 'awaiting_approval' : 'active',
      },
    });

    console.log(`[Geo Worker Pipeline] Appended Landmark task chain for Listing Ref: ${listingId}`);

    // 5. WhatsApp agent-intake listings: send the preview link directly.
    // The listing preview page shows a satellite map with a draggable pin —
    // the agent can visually verify the location, drag the pin to fix it if
    // needed, and click Save, then reply "yes" to publish. This is better
    // than a text address confirmation: a formatted_address string is hard
    // to verify mentally, the map is the right tool.
    if (draftId) {
      await agentIntakeQueue.add('send-preview', { draftId, listingId }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    }

    console.log(`[Job ${job.id}] Successfully completed Geocoding & media initialization mapping for ${listingId}.`);
    return { success: true, coordinates: { lat, lng } };

  } catch (error) {
    console.error(`[Job ${job.id}] Geo-Enrichment Core Handler Failed:`, error.message);
    throw error; // Retained for automatic BullMQ incremental backoff retry scheduling
  }
}, { connection: redisConnection });

// Event monitoring listeners
geoWorker.on('failed', async (job, err) => {
  console.error(`❌ [Job ${job?.id}] Geo-enrichment task failed permanently:`, err.message);

  // WhatsApp agent-intake listings: this failure is otherwise silent (the
  // dashboard-created path has no viewer waiting on it, so that behavior is
  // intentionally left unchanged) — but an agent who just texted in an
  // address deserves to know it couldn't be located, and their draft
  // shouldn't stay stuck.
  const draftId = job?.data?.draftId;
  if (draftId && job.attemptsMade >= job.opts.attempts) {
    try {
      const draft = await knex('agent_listing_drafts').where({ id: draftId }).first();
      if (!draft) return;
      const agentUser = await knex('users').where({ id: draft.user_id }).first();

      await knex('agent_listing_drafts').where({ id: draftId }).update({ status: 'collecting', updated_at: knex.fn.now() });

      const body = "Yeh address locate nahi ho paya. Please ek clearer address bhejein (jaise: sector/colony, city).";
      await knex.transaction(async (trx) => { await logAgentOutboundMessage(trx, { draftId, body }); });
      await enqueueAgentWhatsappSend({ tenantId: draft.tenant_id, phone: agentUser.phone, messageBody: body });
    } catch (notifyErr) {
      console.error(`[Job ${job?.id}] Failed to notify agent of geocode failure:`, notifyErr.message);
    }
  }
});

module.exports = geoWorker;
