// src/workers/landmarkWorker.js
const { Worker, Queue } = require('bullmq');
const axios = require('axios');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

// Core mapping dictionary to map Google Place Types to our strict schema categories
const PLACE_TYPE_MAP = {
  school: 'school',
  primary_school: 'school',
  secondary_school: 'school',
  hospital: 'hospital',
  medical_center: 'hospital',
  doctor: 'hospital',
  supermarket: 'market',
  shopping_mall: 'market',
  grocery_or_supermarket: 'market',
  transit_station: 'transit',
  bus_station: 'transit',
  train_station: 'transit'
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
    // 1. Fire Google Places API Nearby Request seeking core infrastructural types within a 2000m radius
    const typesToSearch = ['school', 'hospital', 'shopping_mall', 'transit_station'];
    let collectedPlaces = [];

    for (const searchType of typesToSearch) {
      const placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=2000&type=${searchType}&key=${targetApiKey}`;
      const response = await axios.get(placesUrl);

      if (response.data.status === 'OK' || response.data.status === 'ZERO_RESULTS') {
        const results = response.data.results || [];
        // Grab up to top 3 nearest locations per type block to prevent database bloat
        collectedPlaces = [...collectedPlaces, ...results.slice(0, 3)];
      }
    }

    // 2. Process and compute distance matrices iteratively
    const landmarkInserts = collectedPlaces.map(place => {
      const placeLat = place.geometry.location.lat;
      const placeLng = place.geometry.location.lng;

      // Haversine/Coarse matrix mapping logic to calculate walking vs driving estimates quickly
      // (1000 meters ~ 12 minutes walk, ~3 minutes drive under typical Ludhiana town transit speeds)
      const distanceMeters = Math.round(calculateHaversineDistance(lat, lng, placeLat, placeLng));
      
      let walkMinutes = Math.round((distanceMeters / 80)); // 80 meters per minute standard walking pace
      let driveMinutes = Math.round((distanceMeters / 300)); // 300 meters per minute coarse driving rate

      // Identify primary type mapping category — no genuine match means this
      // place isn't actually a school/hospital/market/transit point (Google's
      // Nearby Search can return unrelated businesses alongside a real
      // match), so drop it instead of defaulting to 'market' and mislabeling
      // it as a fake landmark.
      const primaryType = place.types.find(t => PLACE_TYPE_MAP[t]);
      if (!primaryType) return null;
      const normalizedType = PLACE_TYPE_MAP[primaryType];

      return {
        id: knex.raw('uuid_generate_v4()'),
        listing_id: listingId,
        place_name: place.name,
        place_type: normalizedType,
        lat: placeLat,
        lng: placeLng,
        distance_meters: distanceMeters,
        walk_minutes: walkMinutes > 0 ? walkMinutes : 1,
        drive_minutes: driveMinutes > 0 ? driveMinutes : 1,
        fetched_at: knex.fn.now()
      };
    }).filter(Boolean);

    // 3. Clear any historical landmarks and batch write new assets into the transactional pool cleanly
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