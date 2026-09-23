// src/workers/geoEnrichmentWorker.js
const { Worker, Queue } = require('bullmq');
const axios = require('axios');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { logAgentOutboundMessage, enqueueAgentWhatsappSend, detectDraftLanguage } = require('../services/agentMessagingService');
const { applyResolvedLocation, extractGeneralArea } = require('../services/locationResolutionService');
const { lookupResolvedLocality, recordResolvedLocality } = require('../services/resolvedLocalityService');
const { validateAddress } = require('../services/addressValidation');
const { resolveWithConsensus } = require('../services/geoConsensusService');
const { mapplsGeocode } = require('../services/mapplsGeocodingService');
const { createLocalityMatcher } = require('../services/locality/localityMatcher');

// Locality Master — resolves the dealer's raw address TEXT (independent of
// whatever lat/lng Google/Mappls landed on above) against a curated list of
// known areas, with the geocoded/pin coordinates used only as a secondary
// cross-check (see localityMatcher.js). One instance per worker process,
// same lifetime as `knex` above.
const localityMatcher = createLocalityMatcher({ knex });

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Connect to dedicated background Redis event broker
const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

const agentIntakeQueue = new Queue('agent-listing-intake', { connection: redisConnection });

console.log(`[Worker Engine] Initializing Geo-Enrichment Task Consumer...`);

// Precise-enough for a house-level pin — the two lower Geocoding API
// precision tiers (GEOMETRIC_CENTER: centroid of a wider area like a
// street or neighborhood; APPROXIMATE: an even coarser guess) are exactly
// what produces a pin that's a street, or a kilometer or two, off from
// the actual house — see tryPlacesTextSearch below for why.
const HIGH_PRECISION_LOCATION_TYPES = ['ROOFTOP', 'RANGE_INTERPOLATED'];

// Address Validation API equivalent of the above — verdict.validationGranularity
// values below PREMISE/SUB_PREMISE (ROUTE, BLOCK, PREMISE_PROXIMITY, OTHER)
// mean the same "resolved to a street/area, not a specific house" gap that
// HIGH_PRECISION_LOCATION_TYPES exists to catch on the legacy Geocoding path.
// verdict.addressComplete alone does NOT imply this — a road-only input like
// "Ferozepur Road, Ludhiana" comes back addressComplete:true with
// validationGranularity:"ROUTE", which is exactly the coarse-pin case this
// is meant to catch, not confidence that it didn't happen.
const HIGH_PRECISION_VALIDATION_GRANULARITIES = ['PREMISE', 'SUB_PREMISE'];

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
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Returns absolute value in meters
}

async function tryPlacesTextSearch(rawAddress, apiKey, geoBiasBounds, circleBias = null, geocodeLat = null, geocodeLng = null) {
  try {
    let locationBias = '';
    if (circleBias) {
      locationBias = `&locationbias=circle:${circleBias.radius}@${circleBias.lat},${circleBias.lng}`;
    } else if (geoBiasBounds) {
      locationBias = `&locationbias=rectangle:${geoBiasBounds}`;
    }
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(rawAddress)}&inputtype=textquery&fields=geometry,formatted_address,place_id&region=in${locationBias}&key=${apiKey}`;
    const response = await axios.get(url, { timeout: 8000 });
    const candidate = response.data.status === 'OK' ? response.data.candidates?.[0] : null;
    if (!candidate?.geometry?.location) return null;

    // Places' "most prominent match" for the query text can be a real,
    // correctly-indexed place that's simply nowhere near where we're
    // actually looking  a same-named colony in the wrong part of town, or
    // (without geoBiasBounds/circleBias) anywhere in India. Google never
    // flags this as an error since the place itself is genuine. Sanity-check
    // against the geocoder's own estimate before trusting it; a match this
    // far off is worse than the low-precision geocode it was meant to fix.
    const MAX_CANDIDATE_DRIFT_METERS = 3000;
    if (geocodeLat != null && geocodeLng != null) {
      const driftMeters = calculateHaversineDistance(
        geocodeLat, geocodeLng,
        candidate.geometry.location.lat, candidate.geometry.location.lng
      );
      if (driftMeters > MAX_CANDIDATE_DRIFT_METERS) {
        console.log(`Places candidate rejected: ${Math.round(driftMeters)}m from geocode estimate (max ${MAX_CANDIDATE_DRIFT_METERS}m).`);
        return null;
      }
    }

    return {
      lat: candidate.geometry.location.lat,
      lng: candidate.geometry.location.lng,
      formattedAddress: candidate.formatted_address || null,
      placeId: candidate.place_id || null,
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
  // WhatsApp/mobile-keyboard autocorrect sometimes substitutes a
  // typographic dash (en dash, em dash, etc.) for a plain ASCII hyphen —
  // e.g. "Ludhiana, Punjab – 142027" (en dash before the pincode). Google's
  // Geocoding API has been seen to ZERO_RESULTS on these where the plain-
  // hyphen equivalent resolves fine. Normalize before anything else touches
  // this text. The character class covers hyphen/dash variants U+2010
  // (hyphen) through U+2015 (horizontal bar).
  let geocodeAddress = rawAddress.replace(/[‐-―]/g, '-');
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

    let lat, lng, formattedAddress, lowConfidence = false, geoValidationResponseId = null;
    // Set only when the coordinates came from the ZERO_RESULTS rescue path
    // below (Places or Mappls, with no successful Google geocode to anchor
    // to) — skips the Mappls cross-check further down, which needs a real
    // Google lat/lng to compare against and would otherwise compare Mappls
    // against itself or against a rescue coordinate it has no business
    // "agreeing" or "disagreeing" with.
    let geoResolutionSourceOverride = null;
    let generalArea = null;
    // Tracked across both the Address Validation and legacy Geocoding
    // branches below so the Mappls consensus step (after this if/else) has
    // one consistent signal for "did Google itself already reach
    // house-level precision" regardless of which path produced it.
    let googleIsHighPrecision = false;

    if (cacheHit) {
      console.log(`[Job ${job.id}] Resolved-locality cache HIT (${cacheHit.key_type}="${cacheHit.display_name}", confidence=${cacheHit.confidence}) — skipping Google geocode.`);
      lat = Number(cacheHit.lat);
      lng = Number(cacheHit.lng);
      formattedAddress = cacheHit.formatted_address || null;
      generalArea = extractGeneralArea(null, formattedAddress); // no address_components on a cache hit — text-heuristic fallback
    } else {
      const useAddressValidation = process.env.USE_ADDRESS_VALIDATION_API === 'true';

      if (useAddressValidation) {
        // Address Validation API path — replaces Geocoding + Places fallback.
        // Returns per-component confidence so we can programmatically detect
        // bad pins rather than relying on Google's silent coarse-match behaviour.
        const { result, responseId } = await validateAddress({
          addressLines: [geocodeAddress],
          apiKey: targetApiKey,
        });

        lat = result.geocode.location.latitude;
        lng = result.geocode.location.longitude;
        formattedAddress = result.address?.formattedAddress || null;
        geoValidationResponseId = responseId || null;
        generalArea = extractGeneralArea(null, formattedAddress);

        const hasSuspiciousComponent = result.address?.addressComponents?.some(
          c => c.confirmationLevel === 'UNCONFIRMED_AND_SUSPICIOUS'
        );
        const isHouseLevelGranularity = HIGH_PRECISION_VALIDATION_GRANULARITIES.includes(
          result.verdict?.validationGranularity
        );
        // possibleNextAction, not addressComplete — Google OMITS addressComplete
        // entirely (not addressComplete:false) whenever possibleNextAction isn't
        // ACCEPT, so `!result.verdict?.addressComplete` only worked before by
        // accident (undefined is falsy too). possibleNextAction is always
        // present in the response, ACCEPT or otherwise, so it's the actual
        // explicit signal Google intends callers to check.
        const isAcceptVerdict = result.verdict?.possibleNextAction === 'ACCEPT';
        lowConfidence = !isAcceptVerdict || !!hasSuspiciousComponent || !isHouseLevelGranularity;
        googleIsHighPrecision = !lowConfidence;

        if (lowConfidence) {
          console.log(`[Job ${job.id}] Address Validation: low-confidence result (possibleNextAction=${result.verdict?.possibleNextAction ?? 'MISSING'}, suspiciousComponent=${hasSuspiciousComponent}, validationGranularity=${result.verdict?.validationGranularity}).`);
        }
      } else {
      // 1. Dispatch lookup request directly to Google Geocoding engine
      //
      // Task 4 fix: neither this call nor the pincode-fallback retry below
      // ever had a `timeout` set — axios defaults to 0 (no timeout) when
      // omitted, unlike every OTHER outbound call in this same pipeline
      // (tryPlacesTextSearch above, the Address Validation branch,
      // mapplsGeocodingService.js), all of which explicitly set 8000ms.
      // A stalled connection here (Google accepts the TCP connection but
      // goes quiet, rather than refusing outright) would hang on the
      // underlying OS socket timeout instead — commonly ~2 minutes on
      // Linux, which matches the reported "response time went from ~7-8s
      // to 2+ minutes" regression exactly. Worse, this worker's BullMQ
      // concurrency processes one job at a time by default, so a single
      // stalled geocode call stalls every OTHER listing's geocoding queued
      // behind it too, not just the one that triggered it. This is also
      // the most likely explanation for the reported listing showing "no
      // longer available" — publicListingController.js only ever serves
      // status='active' listings; a job that's still hung (or that
      // eventually failed after minutes) leaves the listing sitting in
      // 'pending'/'enriching'/'pending_geo_review' indefinitely, which
      // renders as that exact generic message.
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(geocodeAddress)}&components=${effectiveComponents}${effectiveBoundsParam}&key=${targetApiKey}`;
      let response = await axios.get(geoUrl, { timeout: 8000 });

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
        const fallbackResponse = await axios.get(fallbackUrl, { timeout: 8000 });
        if (fallbackResponse.data.status === 'OK') {
          response = fallbackResponse;
        }
      }

      if (response.data.status !== 'OK') {
        // Total miss, even after the pincode-relaxed retry above — e.g.
        // hyper-local plot-number-first addresses Google's Geocoding index
        // doesn't resolve unless anchored to a bigger landmark. Places
        // "Find Place from Text" does fuzzy matching against real indexed
        // places rather than strict structured-address parsing, so it can
        // still succeed here. Unlike the low-precision rescue below, there's
        // no successful geocode point yet to anchor a tight circleBias to —
        // only the broader tenant-level bounds (if configured).
        let zeroResultsRescue = await tryPlacesTextSearch(geocodeAddress, targetApiKey, geoBiasBounds);
        let rescueSource = zeroResultsRescue ? 'places' : null;

        // Places also came up empty — try Mappls directly (not the
        // consensus cross-check in geoConsensusService.js, which needs a
        // Google lat/lng to compare against and can't run when Google found
        // nothing at all). Mappls' own address index tends to cover
        // hyper-local Indian addresses — informal colony/block names,
        // plot-first addressing — better than Google's in exactly the tier-
        // 2/3 towns this platform serves, so it's a genuinely different
        // shot at the same address, not just another guess. Gated behind
        // the same flag as the consensus check — off until Mappls is
        // actually provisioned/active.
        if (!zeroResultsRescue && process.env.MAPPLS_GEO_CONSENSUS_ENABLED === 'true') {
          const mapplsRescue = await mapplsGeocode(geocodeAddress, listingData.pincode);
          if (mapplsRescue && !mapplsRescue.coordsUnavailable) {
            zeroResultsRescue = { lat: mapplsRescue.lat, lng: mapplsRescue.lng, formattedAddress: mapplsRescue.formattedAddress };
            rescueSource = 'mappls';
          }
        }

        if (!zeroResultsRescue) {
          throw new Error(`Google Maps Platform rejected lookup parameter with status code: ${response.data.status}`);
        }
        console.log(`[Job ${job.id}] Geocoding returned ${response.data.status} — ${rescueSource} rescued it.`);
        ({ lat, lng, formattedAddress } = zeroResultsRescue);
        generalArea = extractGeneralArea(null, formattedAddress);
        // Rescued from a total miss, never treat as house-level confident —
        // still worth having SOME pin over none at all, but it needs the
        // same scrutiny as any other low-precision result (Fix 4's
        // geo-review gate).
        googleIsHighPrecision = false;
        lowConfidence = true;
        geoResolutionSourceOverride = rescueSource === 'mappls' ? 'mappls_only_google_zero_results' : 'places_only_google_zero_results';
      } else {

      const result = response.data.results[0];
      formattedAddress = result.formatted_address;
      ({ lat, lng } = result.geometry.location);
      // Distance-tolerant even if Places overrides lat/lng/formattedAddress
      // below — the Places locationbias circle already keeps that
      // correction within the same neighbourhood as this geocode, so the
      // locality-level area is still accurate enough either way.
      generalArea = extractGeneralArea(result.address_components, formattedAddress);

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
      googleIsHighPrecision = isHighPrecision;
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
        const AMBIGUOUS_STREET_RE = /,?\s*(street\s+(number|no\.?)\s*\d+|gali\s+(number|no\.?)?\s*\d+)\s*/i;
        const hasAmbiguousStreet = !plusCodeMatch && AMBIGUOUS_STREET_RE.test(geocodeAddress);
        const localityQuery = hasAmbiguousStreet
          ? geocodeAddress
              .replace(AMBIGUOUS_STREET_RE, ', ')
              .replace(/^[,\s]+|[,\s]+$/g, '')
              .replace(/,\s*,/g, ',')
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
          placesResult = await tryPlacesTextSearch(localityQuery, targetApiKey, geoBiasBounds, circleBias, lat, lng);
        }
        if (!placesResult) {
          placesResult = await tryPlacesTextSearch(geocodeAddress, targetApiKey, geoBiasBounds, circleBias, lat, lng);
        }

        if (placesResult) {
          ({ lat, lng, formattedAddress } = placesResult);
          console.log(`[Job ${job.id}] Places text search found a match, using it instead of the low-precision geocode.`);
        } else {
          lowConfidence = true;
        }
      }
      } // end status === 'OK' branch
      } // end useAddressValidation else (geocoding + places path)
    }

    // 1b. Mappls cross-check — automatic, no human step (see
    // geoConsensusService.js for the full decision rules). Skipped on a
    // resolved-locality cache hit: that coordinate was already confirmed
    // by a person on an earlier listing, which is categorically more
    // trustworthy than a fresh cross-check against either provider.
    let mapplsAudit = null;
    let geoResolutionSource = cacheHit ? 'cache' : geoResolutionSourceOverride;
    if (!cacheHit && !geoResolutionSourceOverride && !plusCodeMatch && process.env.MAPPLS_GEO_CONSENSUS_ENABLED === 'true') {
      const consensus = await resolveWithConsensus(
        { lat, lng, isHighPrecision: googleIsHighPrecision, lowConfidence },
        geocodeAddress,
        listingData.pincode
      );
      lat = consensus.lat;
      lng = consensus.lng;
      lowConfidence = consensus.lowConfidence;
      geoResolutionSource = consensus.geoResolutionSource;
      mapplsAudit = consensus.mappls;
      if (mapplsAudit) {
        console.log(`[Job ${job.id}] Mappls cross-check: agreement=${mapplsAudit.agreementMeters}m, houseLevel=${mapplsAudit.isHouseLevel}, source=${geoResolutionSource}`);
      }
    } else if (!cacheHit && !geoResolutionSourceOverride) {
      geoResolutionSource = 'google_only_no_mappls';
    }

    // Super-admin geo review gate (see adminGeoReviewController.js) — a
    // WhatsApp agent-intake listing whose geocode never reached house-level
    // precision (googleIsHighPrecision computed above from location_type /
    // validationGranularity, BEFORE the Mappls consensus step, per the
    // decision to stop trusting the system's own confidence judgment —
    // consensus "agreement" has been wrong before and doesn't get a vote
    // here) gets parked for a human to check instead of being auto-sent to
    // the agent as awaiting_approval. Only applies when a draftId exists
    // (WhatsApp intake — the only flow adminGeoReviewController.js knows
    // how to release, since it looks the listing up by draft) and only when
    // no agent pin has been shared yet — at this point in the pipeline
    // (right after the initial geocode) that's always true; if the agent
    // later shares a real GPS pin, handleAgentLocationPin releases the
    // listing out of review immediately, since a pin is trusted outright.
    const needsGeoReview = !!draftId && !googleIsHighPrecision;

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
        status: needsGeoReview
          ? 'pending_geo_review'
          : (['whatsapp', 'web'].includes(listingData.source) ? 'awaiting_approval' : 'active'),
        // Neither the Geocoding API nor a Places fallback found a
        // confident, house-level match — the pin is a best-effort guess.
        // agentIntakeWorker.js's preview message uses this to add an
        // extra nudge to actually check/drag the pin, not just approve
        // on faith. Cleared automatically the next time this listing is
        // (re-)geocoded from a corrected address.
        location_low_confidence: lowConfidence,
        // Locality-level, no house/plot number — safe to show a buyer
        // before they've contacted the dealer. NULL for any listing this
        // worker doesn't (re-)geocode, i.e. every listing that existed
        // before this feature — PropertyView.jsx falls back to
        // formatted_address for those, so already-shared links are
        // unaffected. See extractGeneralArea above and the marketplace
        // search flow in webhookController.js / buyerSearchService.js.
        general_area: generalArea,
        // Stored so publicListingController.js / agentIntakeController.js can
        // send provideValidationFeedback after a dealer confirms or corrects.
        // NULL when the old Geocoding API path was used.
        geo_validation_response_id: geoValidationResponseId,
        // Mappls cross-check audit trail — see geoConsensusService.js.
        // mappls_lat/lng are Mappls' own candidate, independent of whether
        // it ended up being used for lat/lng above. All null/'cache' or
        // 'google_only_no_mappls' when the consensus check didn't run.
        mappls_lat: mapplsAudit?.lat ?? null,
        mappls_lng: mapplsAudit?.lng ?? null,
        geo_provider_agreement_meters: mapplsAudit?.agreementMeters ?? null,
        geo_resolution_source: geoResolutionSource,
      },
    });

    console.log(`[Geo Worker Pipeline] Appended Landmark task chain for Listing Ref: ${listingId}`);

    // Locality Master tagging — best-effort and purely additive: resolves
    // listingData.raw_address against the curated locality list (see
    // localityMatcher.js), using the coordinates just persisted above as a
    // pin cross-check. Only ever writes locality_id when the match is
    // confident enough to auto-accept ('confirm'/'unmatched' results are
    // left for a dealer/admin flow to wire up later — see PR description);
    // a miss or an error here never blocks or fails the geocoding job that
    // already succeeded by this point, same non-fatal pattern as the
    // resolved-locality cache write in publicListingController.js.
    try {
      const tenantForLocality = await knex('tenants').where({ id: listingData.tenant_id }).first();
      const localityCity = tenantForLocality?.operating_city || 'Ludhiana';
      const localityResult = await localityMatcher.match({
        city: localityCity,
        text: listingData.raw_address,
        lat,
        lng,
        listingId,
      });
      if (localityResult.decision === 'auto') {
        await localityMatcher.applyToListing(listingId, localityResult);
        console.log(`[Job ${job.id}] Locality Master: tagged "${localityResult.name}" (${localityResult.method}, ${localityResult.confidence}).`);
      }
    } catch (localityErr) {
      console.error(`[Job ${job.id}] Locality Master match failed (non-fatal):`, localityErr.message);
    }

    // Low-confidence WhatsApp listing: ask the agent to share a real GPS
    // pin (WhatsApp's own "share location" feature) as a second, stronger
    // verification signal than the pin-drag-on-preview nudge already in
    // sendPreviewAndAwaitApproval's message — that one only works if the
    // agent actually looks closely at a satellite image; a GPS pin is an
    // explicit, unambiguous coordinate. See agentIntakeController.js's
    // handleAgentLocationPin for what happens when it arrives. Sent
    // ahead of send-preview below (not instead of it) — the preview flow
    // is unchanged, this is purely an additional prompt.
    if (draftId && lowConfidence) {
      const draftForPinRequest = await knex('agent_listing_drafts').where({ id: draftId }).first();
      const agentForPinRequest = draftForPinRequest
        ? await knex('users').where({ id: draftForPinRequest.user_id }).first()
        : null;

      if (agentForPinRequest) {
        const lang = await detectDraftLanguage(knex, draftId);
        const pinRequestBody = lang === 'en'
          ? "📍 We couldn't pin this address precisely. If you can, open WhatsApp's location feature and share the property's exact location — tap the ➕/attachment icon, choose *Location*, then *Share Live Location* or drop a pin on the map at the property."
          : '📍 Yeh address bilkul sahi se locate nahi ho paya. Agar ho sake to WhatsApp ke location feature se property ki exact location share karein — ➕/attachment icon dabayein, *Location* choose karein, phir property pe pin drop karke share karein.';
        await knex.transaction(async (trx) => {
          await logAgentOutboundMessage(trx, { draftId, body: pinRequestBody });
        });
        await enqueueAgentWhatsappSend({ tenantId: listingData.tenant_id, phone: agentForPinRequest.phone, messageBody: pinRequestBody });
      }
    }

    // WhatsApp agent-intake listings: send the preview link directly.
    // The listing preview page shows a satellite map with a draggable pin —
    // the agent can visually verify the location, drag the pin to fix it if
    // needed, and click Save, then reply "yes" to publish. Skipped when
    // parked in pending_geo_review — the preview goes out once a super-admin
    // approves it instead (adminGeoReviewController.js enqueues this same
    // job), or immediately if the agent shares a trusted GPS pin first
    // (agentIntakeController.js's handleAgentLocationPin).
    if (draftId && !needsGeoReview) {
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

  const { listingId, draftId } = job?.data || {};

  // A listing that exhausts every geocode retry currently just sits with no
  // lat/lng and no signal anywhere that anything went wrong — dashboard-
  // created listings especially, since (see below) only WhatsApp intake
  // gets a chat notification. Flag it on the listing row itself, regardless
  // of source, so these are at least queryable/reviewable instead of
  // silently invisible.
  if (listingId && job.attemptsMade >= job.opts.attempts) {
    try {
      await knex('listings').where({ id: listingId }).update({
        location_low_confidence: true,
        geo_resolution_source: 'geocode_failed',
        updated_at: knex.fn.now(),
      });
    } catch (flagErr) {
      console.error(`[Job ${job?.id}] Failed to flag listing ${listingId} after permanent geocode failure:`, flagErr.message);
    }
  }

  // WhatsApp agent-intake listings: this failure is otherwise silent (the
  // dashboard-created path has no viewer waiting on it, so that behavior is
  // intentionally left unchanged) — but an agent who just texted in an
  // address deserves to know it couldn't be located, and their draft
  // shouldn't stay stuck.
  if (draftId && job.attemptsMade >= job.opts.attempts) {
    try {
      const draft = await knex('agent_listing_drafts').where({ id: draftId }).first();
      if (!draft) return;
      const agentUser = await knex('users').where({ id: draft.user_id }).first();

      // Reset accumulated_text along with the status bounce-back — the
      // listing already exists, and whatever text produced this failed
      // geocode has been fully consumed. Without this reset, the agent's
      // next reply gets appended onto the OLD (already-failed) address
      // text instead of replacing it, which is the confirmed mechanism
      // behind the session-bleed/address-gluing bug (see
      // agentIntakeWorker.js's creation-path reset for the full story).
      await knex('agent_listing_drafts').where({ id: draftId }).update({ status: 'collecting', accumulated_text: '', updated_at: knex.fn.now() });

      const body = "Yeh address locate nahi ho paya. Please ek clearer address bhejein (jaise: sector/colony, city).";
      await knex.transaction(async (trx) => { await logAgentOutboundMessage(trx, { draftId, body }); });
      await enqueueAgentWhatsappSend({ tenantId: draft.tenant_id, phone: agentUser.phone, messageBody: body });
    } catch (notifyErr) {
      console.error(`[Job ${job?.id}] Failed to notify agent of geocode failure:`, notifyErr.message);
    }
  }
});

module.exports = geoWorker;
