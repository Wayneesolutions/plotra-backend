// src/workers/localIntelligenceWorker.js
//
// Consumes queue 'local-intelligence', triggered by geoEnrichmentWorker.js
// right alongside the landmark-extraction hand-off (same reasoning: not
// needed for the OG preview card, safe to generate in the background).
// Uses groundedResearchService.js's web-search-grounded GPT call — a
// genuinely different OpenAI endpoint from vocallmWorker.js/
// agentIntakeWorker.js's closed-book chat.completions calls, since this
// must never invent a crime rate or local news item.
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { generateLocalIntelligence } = require('../services/groundedResearchService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

console.log(`[Worker Engine] Initializing Local Intelligence Researcher...`);

const localIntelligenceWorker = new Worker('local-intelligence', async (job) => {
  const { listingId, formattedAddress, propertyType } = job.data;

  console.log(`[Job ${job.id}] Researching local intelligence for listing ${listingId}`);

  const listing = await knex('listings').where({ id: listingId }).first();
  if (!listing) throw new Error(`Listing ${listingId} no longer exists.`);

  // Upsert a 'pending' row immediately so publicListingController.js has
  // something to key off of even before the (slower, web-search-backed)
  // generation finishes — matches the pattern of listing_media being
  // seeded early elsewhere in the pipeline.
  await knex('listing_local_intelligence')
    .insert({ listing_id: listingId, status: 'pending' })
    .onConflict('listing_id')
    .merge({ status: 'pending', updated_at: knex.fn.now() });

  try {
    const result = await generateLocalIntelligence({
      formattedAddress: formattedAddress || listing.formatted_address || listing.raw_address,
      propertyType: propertyType || listing.property_type,
    });

    const hasAnyContent = result.citationCount > 0;

    await knex('listing_local_intelligence')
      .where({ listing_id: listingId })
      .update({
        status: hasAnyContent ? 'completed' : 'no_data',
        summary_json: JSON.stringify({ news: result.news, safety: result.safety, seasonal: result.seasonal }),
        raw_response_text: result.rawResponseText,
        citation_count: result.citationCount,
        generated_at: knex.fn.now(),
        error_message: null,
        updated_at: knex.fn.now(),
      });

    console.log(`[Job ${job.id}] Local intelligence generated for listing ${listingId}: ${result.citationCount} cited items.`);
    return { success: true, citationCount: result.citationCount };
  } catch (error) {
    console.error(`[Job ${job.id}] Local Intelligence generation failed:`, error.message);

    await knex('listing_local_intelligence')
      .where({ listing_id: listingId })
      .update({
        status: 'failed',
        error_message: error.message.slice(0, 1000),
        updated_at: knex.fn.now(),
      });

    throw error; // let BullMQ's normal retry/backoff apply
  }
}, { connection: redisConnection });

localIntelligenceWorker.on('failed', (job, err) => {
  console.error(`❌ [Job ${job?.id}] Local Intelligence task failed permanently:`, err.message);
});

module.exports = localIntelligenceWorker;
