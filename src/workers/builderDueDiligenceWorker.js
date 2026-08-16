// src/workers/builderDueDiligenceWorker.js
//
// Consumes queue 'builder-due-diligence', job 'research'. Triggered by
// builderProfileController.js's linkOrCreateBuilderProfile only when a NEW
// builder_profiles row is created — an existing (already-researched) profile
// is reused across every listing that links to it, not re-researched.
//
// Every claim this writes has already passed groundedResearchService.js's
// filterCitedItems() (safeguard #1) and the DB's source_url NOT NULL
// constraint is safeguard #2. This worker deliberately does NOT touch
// moderation_status — that stays 'pending_review' until a human explicitly
// publishes it (safeguard #3, in builderProfileController.js). Research
// completing is not the same thing as being cleared to show buyers.
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { generateBuilderClaims } = require('../services/groundedResearchService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

console.log(`[Worker Engine] Initializing Builder Due Diligence Researcher...`);

const builderDueDiligenceWorker = new Worker('builder-due-diligence', async (job) => {
  if (job.name !== 'research') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on builder-due-diligence, skipping.`);
    return { success: false, skipped: true };
  }

  const { builderProfileId } = job.data;
  console.log(`[Job ${job.id}] Researching builder profile ${builderProfileId}`);

  const profile = await knex('builder_profiles').where({ id: builderProfileId }).first();
  if (!profile) throw new Error(`Builder profile ${builderProfileId} no longer exists.`);

  await knex('builder_profiles').where({ id: builderProfileId }).update({ research_status: 'researching', updated_at: knex.fn.now() });

  try {
    const { claims } = await generateBuilderClaims({ companyName: profile.company_name });

    await knex.transaction(async (trx) => {
      // Clear any prior claims (re-research case, e.g. a future manual
      // refresh) before inserting the current set.
      await trx('builder_profile_claims').where({ builder_profile_id: builderProfileId }).del();

      if (claims.length > 0) {
        await trx('builder_profile_claims').insert(
          claims.map((c) => ({
            builder_profile_id: builderProfileId,
            category: c.category,
            claim_text: c.claim_text,
            source_url: c.source_url,
            source_title: c.source_title,
            source_domain: c.source_domain,
          }))
        );
      }

      await trx('builder_profiles').where({ id: builderProfileId }).update({
        research_status: 'completed',
        last_researched_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
    });

    console.log(`[Job ${job.id}] Builder due diligence completed for "${profile.company_name}": ${claims.length} cited claims.`);
    return { success: true, claimCount: claims.length };
  } catch (error) {
    console.error(`[Job ${job.id}] Builder Due Diligence research failed:`, error.message);
    await knex('builder_profiles').where({ id: builderProfileId }).update({ research_status: 'failed', updated_at: knex.fn.now() });
    throw error; // let BullMQ's normal retry/backoff apply
  }
}, { connection: redisConnection });

builderDueDiligenceWorker.on('failed', (job, err) => {
  console.error(`❌ [Job ${job?.id}] Builder Due Diligence task failed permanently:`, err.message);
});

module.exports = builderDueDiligenceWorker;
