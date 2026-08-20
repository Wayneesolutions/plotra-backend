// src/workers/geoEnrichmentWorker.js
const { Worker, Queue } = require('bullmq');
const axios = require('axios');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { logAgentOutboundMessage, enqueueAgentWhatsappSend } = require('../services/agentMessagingService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Connect to dedicated background Redis event broker
const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

// Queue used to hand off to landmarkWorker.js once coordinates are known
const landmarkQueue = new Queue('landmark-extraction', { connection: redisConnection });
// Local Intelligence (real, cited neighborhood news/safety/seasonal context)
// — same reasoning as landmarks for not blocking anything on it: not shown
// in the OG preview card, safe to generate in the background.
const localIntelligenceQueue = new Queue('local-intelligence', { connection: redisConnection });
// Only used for WhatsApp agent-intake listings (job.data.draftId present) —
// see agentIntakeWorker.js's 'send-preview' handler.
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

  try {
    // 1. Dispatch lookup request directly to Google Geocoding engine
    // Adding local market region indicators to target Ludhiana/Punjab boundaries securely
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(rawAddress)}&components=country:IN&key=${targetApiKey}`;
    const response = await axios.get(geoUrl);

    if (response.data.status !== 'OK') {
      throw new Error(`Google Maps Platform rejected lookup parameter with status code: ${response.data.status}`);
    }

    const result = response.data.results[0];
    const formattedAddress = result.formatted_address;
    const { lat, lng } = result.geometry.location;

    // 2. Persist calculations back to listings inside a safe database transaction block
    await knex.transaction(async (trx) => {
      await trx('listings')
        .where({ id: listingId })
        .update({
          formatted_address: formattedAddress,
          lat: lat,
          lng: lng,
          // Conversational-intake listings (source: 'whatsapp' or 'web') wait
          // for an approval reply in that same conversation before going
          // publicly active — see agentIntakeController.js/
          // agentIntakeWorker.js for WhatsApp, webChatController.js for the
          // web-chat channel. Dashboard-created listings keep the original
          // immediate pending->active behavior, unchanged.
          status: ['whatsapp', 'web'].includes(listingData.source) ? 'awaiting_approval' : 'active',
          updated_at: knex.fn.now()
        });

      // 3. Initialize default structural records inside the listing_media table to avoid null errors on the UI
      // Pre-configures maps snapshots for immediate rendering
      const staticSatelliteUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=18&size=800x450&maptype=satellite&key=${targetApiKey}`;
      const staticStreetViewUrl = `https://maps.googleapis.com/maps/api/streetview?size=800x450&location=${lat},${lng}&key=${targetApiKey}`;

      await trx('listing_media')
        .insert({
          id: knex.raw('uuid_generate_v4()'),
          listing_id: listingId,
          satellite_image_url: staticSatelliteUrl,
          streetview_image_url: staticStreetViewUrl,
          fetched_at: knex.fn.now()
        })
        .onConflict('listing_id')
        .merge();
    });

    // 4. Now that coordinates exist, hand off to the landmark worker (Phase 2 enrichment)
    await landmarkQueue.add('extract-infra-landmarks', {
      listingId: listingId,
      lat: lat,
      lng: lng
    }, {
      attempts: 2,
      backoff: 1000
    });

    console.log(`[Geo Worker Pipeline] Appended Landmark task chain for Listing Ref: ${listingId}`);

    // 4b. Also kick off Local Intelligence research in parallel — independent
    // of the landmark chain, so a slow/failed web-search-grounded lookup
    // never blocks or fails listing creation itself.
    await localIntelligenceQueue.add('generate', {
      listingId: listingId,
      formattedAddress: formattedAddress,
      propertyType: listingData.property_type,
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
    });

    // 5. WhatsApp agent-intake listings: don't block on landmarks finishing
    // (they're not shown in the OG preview card — title/image/price only,
    // and by the time a human reacts to WhatsApp, landmark extraction has
    // almost always already finished anyway) — send the approval-preview
    // message now.
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
