// src/workers/landmarkWorker.js
const { Worker, Queue } = require('bullmq');
const axios = require('axios');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

// One Google Places "type" searched per category, and the category label it
// maps to in our schema. Previously this ran FOUR searches (school, hospital,
// shopping_mall, transit_station) but then re-derived each result's category
// by scanning ITS OWN place.types array against a much bigger map — which
// silently mislabeled anything whose Google type tags didn't happen to
// include one of ~10 hardcoded keys, dumping it into 'market' by default
// REGARDLESS of which search actually found it (a school found via the
// "school" search, with no exact "school" tag in its own types array — not
// uncommon for coaching institutes, smaller private schools, etc. — would
// silently become a "market" entry). Searching one type per category and
// trusting the category we searched for, rather than re-inferring it from
// ambiguous data Google itself sends back inconsistently, removes that
// entire class of mislabeling.
//
// shopping_mall -> supermarket: a full shopping mall is the wrong Google
// category for what "nearby market" means to a buyer in a Punjab/Tier-2-3
// India town (a local market/grocery, not a mall) — supermarket is a much
// closer real-world match, and was already declared (but never actually
// searched) in the old map.
const CATEGORY_SEARCH_TYPES = {
  school: 'school',
  hospital: 'hospital',
  market: 'supermarket',
  transit: 'transit_station',
};

console.log(`[Worker Engine] Initializing Regional Landmark Extractor...`);

const landmarkWorker = new Worker('landmark-extraction', async (job) => {
  const { listingId, lat, lng } = job.data;
  
  console.log(`[Job ${job.id}] Extracting regional infra landmarks around coordinates: [${lat}, ${lng}]`);

  const listing = await knex('listings').where({ id: listingId }).first();
  if (!listing) throw new Error(`Listing context ${listingId} no longer exists.`);

  const config = await knex('tenant_configs').where({ tenant_id: listing.tenant_id }).first();
  const targetApiKey = config?.google_maps_api_key_override || process.env.GOOGLE_MAPS_API_KEY;

  if (!targetApiKey) throw new Error('Missing available API credential token.');

  try {
    // 1. One Google Places Nearby Search per category, ranked by actual
    // distance (rankby=distance) rather than the API's default "prominence"
    // ranking. Prominence surfaces well-known/highly-rated places even when
    // a much closer, smaller one exists — exactly what produced "nearby"
    // landmarks that weren't really nearby. Google requires `radius` to be
    // OMITTED when using rankby=distance (the two are mutually exclusive),
    // so there's no explicit distance cap here — that's fine, the code
    // below already sorts by real haversine distance before keeping only
    // the closest 3 per category.
    let collectedPlaces = [];

    for (const [category, searchType] of Object.entries(CATEGORY_SEARCH_TYPES)) {
      const placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&rankby=distance&type=${searchType}&key=${targetApiKey}`;
      const response = await axios.get(placesUrl);

      if (response.data.status === 'OK' || response.data.status === 'ZERO_RESULTS') {
        const results = response.data.results || [];
        for (const place of results) {
          collectedPlaces.push({ place, category });
        }
      }
    }

    // 2. Compute real distance for every candidate, dedupe (the same place
    // can occasionally surface under more than one search — a hospital with
    // an attached pharmacy/clinic block, for instance), then keep only the
    // 3 geographically closest PER CATEGORY — not just the first 3 Google
    // happened to return.
    const byPlaceId = new Map();
    for (const { place, category } of collectedPlaces) {
      if (byPlaceId.has(place.place_id)) continue;
      const placeLat = place.geometry.location.lat;
      const placeLng = place.geometry.location.lng;
      const distanceMeters = Math.round(calculateHaversineDistance(lat, lng, placeLat, placeLng));
      byPlaceId.set(place.place_id, { place, category, placeLat, placeLng, distanceMeters });
    }

    const nearestPerCategory = Object.keys(CATEGORY_SEARCH_TYPES).flatMap((category) => {
      const candidates = Array.from(byPlaceId.values()).filter((c) => c.category === category);
      candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
      return candidates.slice(0, 3); // nearest 3 of this category, now genuinely nearest
    });

    // 3. Build the DB rows.
    const landmarkInserts = nearestPerCategory.map(({ place, category, placeLat, placeLng, distanceMeters }) => {
      // Haversine/Coarse matrix mapping logic to calculate walking vs driving estimates quickly
      // (1000 meters ~ 12 minutes walk, ~3 minutes drive under typical Ludhiana town transit speeds)
      let walkMinutes = Math.round((distanceMeters / 80)); // 80 meters per minute standard walking pace
      let driveMinutes = Math.round((distanceMeters / 300)); // 300 meters per minute coarse driving rate

      return {
        id: knex.raw('uuid_generate_v4()'),
        listing_id: listingId,
        place_name: place.name,
        place_type: category,
        lat: placeLat,
        lng: placeLng,
        distance_meters: distanceMeters,
        walk_minutes: walkMinutes > 0 ? walkMinutes : 1,
        drive_minutes: driveMinutes > 0 ? driveMinutes : 1,
        fetched_at: knex.fn.now()
      };
    });

    // 4. Clear any historical landmarks and batch write new assets into the transactional pool cleanly
    await knex.transaction(async (trx) => {
      await trx('listing_landmarks').where({ listing_id: listingId }).del();
      if (landmarkInserts.length > 0) {
        await trx('listing_landmarks').insert(landmarkInserts);
      }
    });

    console.log(`[Job ${job.id}] Successfully mapped ${landmarkInserts.length} landmark points for Listing ${listingId}.`);
    return { count: landmarkInserts.length };

  } catch (error) {
    console.error(`[Job ${job.id}] Landmark Extractor critical failure:`, error.message);
    throw error;
  }
}, { connection: redisConnection });

/**
 * Utility helper computing mathematical distance between coordinate nodes
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

module.exports = landmarkWorker;