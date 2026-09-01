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

// Precise-enough for a house-level pin — the two lower Geocoding API
// precision tiers (GEOMETRIC_CENTER: centroid of a wider area like a
// street or neighborhood; APPROXIMATE: an even coarser guess) are exactly
// what produces a pin that's a street, or a kilometer or two, off from
// the actual house — see tryPlacesTextSearch below for why.
const HIGH_PRECISION_LOCATION_TYPES = ['ROOFTOP', 'RANGE_INTERPOLATED'];

/**
 * Google's Geocoding API does strict, structured-address-component
 * parsing — built for a clean, complete postal address. A WhatsApp-typed
 * address ("hno 102 lahri nagar, mundia khurd, chamdigarh road ludhiana")
 * often doesn't parse to house-number precision there; Google doesn't
 * error when that happens, it silently returns a coarser match
 * (location_type GEOMETRIC_CENTER/APPROXIMATE, sometimes with
 * partial_match:true) with nothing in the response shouting "this wasn't
 * confident" unless something actually checks those two fields — which
 * nothing here did before this fix.
 *
 * The Google Maps app's own search box doesn't use raw geocoding for
 * free-text input like this — it uses Places-style fuzzy matching against
 * real indexed places (autocomplete, POIs, house-level results), which is
 * exactly why typing the same address there lands on the exact house
 * while a plain geocode call misses by a kilometer or two. This calls the
 * same family of API (Places "Find Place From Text") as a second attempt
 * whenever the primary geocode comes back low-precision, and the caller
 * prefers its result if it succeeds. Never throws — a failure here (key
 * doesn't have Places enabled, quota, network) just means falling back to
 * whatever the Geocoding API already found, exactly like before this fix.
 */
/**
 * @param {string} address
 * @param {string} apiKey
 * @param {string|null} geoBiasBounds  — broad tenant-level rectangle fallback
 * @param {{lat:number,lng:number,radius:number}|null} circleBias
 *   When provided, overrides geoBiasBounds with a tight circle centered on
 *   the Geocoding API's own (low-precision) result. Keeps Places from
 *   returning any "Street Number 4" in all of Ludhiana — it can only
 *   return results within radius metres of where the geocoder already
 *   landed, which is usually the right neighbourhood even when not
 *   house-level.
 */
async function tryPlacesTextSearch(rawAddress, apiKey, geoBiasBounds, circleBias = null) {
  try {
    let locationBias = '';
    if (circleBias) {
      locationBias = `&locationbias=circle:${circleBias.radius}@${circleBias.lat},${circleBias.lng}`;
    } else if (geoBiasBounds) {
      locationBias = `&locationbias=rectangle:${geoBiasBounds}`;
    }
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(rawAddress)}&inputtype=textquery&fields=geometry,formatted_address&region=in${locationBias}&key=${apiKey}`;
    const response = await axios.get(url, { timeout: 8000 });
    const candidate = response.data.status === 'OK' ? response.data.candidates?.[0] : null;
    if (!candidate?.geometry?.location) return null;

    return {
      lat: candidate.geometry.location.lat,
      lng: candidate.geometry.location.lng,
      formattedAddress: candidate.formatted_address || null,
    };
  } catch (err) {
    console.error('Places text-search fallback failed (non-fatal, keeping Geocoding API result):', err.message);
    return null;
  }
}

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

  // Google Plus Code (Open Location Code) detection — e.g. "VVQC+JCQ" or
  // "7RGH7QCQ+JCQ". When the agent includes one in their address, it
  // encodes an exact GPS location that Google decodes to ROOFTOP
  // precision, making this categorically more accurate than any text-
  // address geocode. Short codes (≤6 chars before +) need a locality
  // anchor to resolve — extract the first place-name segment from the
  // rest of the address. When a Plus Code is present, skip the
  // postal_code filter and bounds bias: both are redundant when the
  // query is already an exact GPS reference, and the postal filter can
  // reject a valid ROOFTOP result if Google's index maps that coordinate
  // to a slightly different postal area.
  const PLUS_CODE_RE = /\b([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b/i;
  const plusCodeMatch = rawAddress.match(PLUS_CODE_RE);
  let geocodeAddress = rawAddress;
  if (plusCodeMatch) {
    const code = plusCodeMatch[1];
    const prefixLen = code.indexOf('+');
    if (prefixLen <= 6) {
      // Short code — needs a locality. Strip the code, then pick the
      // first comma-segment that has no digits (a place name, not a
      // street number or pincode).
      const rest = rawAddress.replace(PLUS_CODE_RE, '').replace(/^[,\s]+|[,\s]+$/g, '');
      const locality = rest.split(',').map(s => s.trim()).find(s => s.length > 0 && !/\d/.test(s)) || rest;
      geocodeAddress = `${code} ${locality}`;
    } else {
      geocodeAddress = code; // full code is self-anchoring
    }
    console.log(`[Job ${job.id}] Plus Code detected — geocoding via "${geocodeAddress}" for ROOFTOP precision.`);
  }
  const effectiveComponents = plusCodeMatch ? 'country:IN' : components;
  const effectiveBoundsParam = plusCodeMatch ? '' : boundsQueryParam;

  // Strip leading proximity/relative words before geocoding — "near
  // Street Number 4" tells the Geocoding API the street is an
  // approximate reference, causing it to match ANY "Street Number 4"
  // in the city instead of the one in the named colony that follows.
  // Stripping just the prefix preserves the colony/area/city context
  // that actually disambiguates. Not applied to Plus Code queries.
  if (!plusCodeMatch) {
    geocodeAddress = geocodeAddress.replace(
      /^(near|opp\.?|opposite|behind|adj\.?|adjacent|beside|next\s+to|in\s+front\s+of)\s+/i, ''
    );
  }

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

    let lat, lng, formattedAddress, lowConfidence = false;

    if (cacheHit) {
      console.log(`[Job ${job.id}] Resolved-locality cache HIT (${cacheHit.key_type}="${cacheHit.display_name}", confidence=${cacheHit.confidence}) — skipping Google geocode.`);
      lat = Number(cacheHit.lat);
      lng = Number(cacheHit.lng);
      formattedAddress = cacheHit.formatted_address || null;
    } else {
      // 1. Dispatch lookup request directly to Google Geocoding engine
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(geocodeAddress)}&components=${effectiveComponents}${effectiveBoundsParam}&key=${targetApiKey}`;
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
        const fallbackUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(geocodeAddress)}&components=country:IN${fallbackBoundsParam}&key=${targetApiKey}`;
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

      // Not a house-level match — this is the actual cause of "typing the
      // same house number into Google Maps finds it exactly, but Plotra
      // is off by a kilometer or two": a coarse geocode that Google never
      // flags as an error. Try Places' fuzzy real-place matching before
      // accepting it; only fall back to the coarse geocode if Places also
      // comes up empty.
      //
      // ROOFTOP is always trusted regardless of partial_match — ROOFTOP
      // means Google resolved the query to an exact building/house rooftop
      // coordinate. partial_match=true on a ROOFTOP result only means the
      // address components were partially ambiguous during parsing, not
      // that the coordinate itself is coarse. Replacing a ROOFTOP result
      // with a Places "Find Place" result (a named-POI centroid) would
      // actively degrade precision, as seen in logs where ROOFTOP jobs
      // were sent to Places and came back as neighborhood centroids.
      // RANGE_INTERPOLATED is also kept without partial_match — it's an
      // interpolated street-range result that is still address-level, and
      // partial_match there does signal genuine ambiguity.
      const isHighPrecision = result.geometry.location_type === 'ROOFTOP'
        || (result.geometry.location_type === 'RANGE_INTERPOLATED' && !result.partial_match);
      if (!isHighPrecision) {
        console.log(`[Job ${job.id}] Geocode came back low-precision (location_type=${result.geometry.location_type}, partial_match=${!!result.partial_match}) — trying Places text search.`);

        // "Street Number X" and "Gali X" naming is used in dozens of
        // colonies across every Punjab city — passing the full address
        // to Places causes it to return the most prominent match for
        // that street number, which is often the wrong colony entirely
        // (as seen: "Street Number 4, Parbhat Nagar, Dholewal Chowk,
        // Ludhiana" geocoded to Gobind Nagar, 10 km away). For these
        // ambiguous patterns, strip the street number and query Places
        // with just the colony + area + city — less precise (200-500 m)
        // but reliably in the right neighbourhood rather than 10 km off.
        // For all other addresses, query Places with the cleaned full address.
        const AMBIGUOUS_STREET_RE = /^(street\s+(number|no\.?)\s*\d+|gali\s+(number|no\.?)?\s*\d+)[,\s]*/i;
        const hasAmbiguousStreet = !plusCodeMatch && AMBIGUOUS_STREET_RE.test(geocodeAddress);
        const localityQuery = hasAmbiguousStreet
          ? geocodeAddress.replace(AMBIGUOUS_STREET_RE, '').replace(/^[,\s]+/, '')
          : null;

        // Use the geocoding result's own coordinates as a tight circle
        // bias for Places instead of the broad tenant-level rectangle.
        // Even a low-precision geocode (GEOMETRIC_CENTER) usually lands
        // in the right neighbourhood; constraining Places to a 4 km
        // radius around it prevents returning any "Street Number 4" in
        // the whole city when the agent meant a specific colony's street.
        const circleBias = { lat, lng, radius: 4000 };

        let placesResult = null;
        if (localityQuery) {
          console.log(`[Job ${job.id}] Ambiguous street-number address — querying Places with locality-only: "${localityQuery}"`);
          placesResult = await tryPlacesTextSearch(localityQuery, targetApiKey, geoBiasBounds, circleBias);
        }
        if (!placesResult) {
          placesResult = await tryPlacesTextSearch(geocodeAddress, targetApiKey, geoBiasBounds, circleBias);
        }

        if (placesResult) {
          ({ lat, lng, formattedAddress } = placesResult);
          console.log(`[Job ${job.id}] Places text search found a match, using it instead of the low-precision geocode.`);
        } else {
          lowConfidence = true;
        }
      }
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
        // Neither the Geocoding API nor a Places fallback found a
        // confident, house-level match — the pin is a best-effort guess.
        // agentIntakeWorker.js's preview message uses this to add an
        // extra nudge to actually check/drag the pin, not just approve
        // on faith. Cleared automatically the next time this listing is
        // (re-)geocoded from a corrected address.
        location_low_confidence: lowConfidence,
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
