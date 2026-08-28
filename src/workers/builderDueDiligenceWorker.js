// src/workers/builderDueDiligenceWorker.js
//
// Consumes queue 'builder-due-diligence', job 'research'. Triggered by
// builderProfileController.js's linkOrCreateBuilderProfile only when a NEW
// builder_profiles row is created — an existing (already-researched) profile
// is reused across every listing that links to it, not re-researched.
//
// Every claim this writes has already passed groundedResearchService.js's
// filterCitedItems() (safeguard #1) and the DB's source_url NOT NULL
// constraint is safeguard #2 — same for overall_rating/possession_*
// (filterCitedSingle() + the CHECK constraints in the 20260824 migration).
// This worker deliberately does NOT touch moderation_status — that stays
// 'pending_review' until a human explicitly publishes it (safeguard #3, in
// builderProfileController.js). Research completing is not the same thing
// as being cleared to show buyers.
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { generateBuilderClaims } = require('../services/groundedResearchService');
const { enqueueAgentWhatsappSend } = require('../services/agentMessagingService');
const { detectReplyLanguage } = require('../utils/replyLanguage');

/**
 * Research completing is silent otherwise (see file header: this worker
 * deliberately never auto-publishes) — before this fix, NOTHING told the
 * tenant owner a builder profile was sitting in pending_review, so it could
 * sit there indefinitely with nobody knowing there was anything to
 * review/publish. Best-effort: a missing/unreachable owner phone should
 * never fail the research job itself, the research result is already
 * safely persisted by the time this runs.
 */
async function notifyOwnerBuilderProfileNeedsReview(knex, { tenantId, companyName, listing }) {
  try {
    const owner = await knex('users').where({ tenant_id: tenantId, role: 'owner' }).first();
    if (!owner?.phone) return; // no owner phone on file — nothing we can notify

    const lang = detectReplyLanguage(listing?.raw_address || listing?.title || null);

    const body = lang === 'en'
      ? `🏗️ Builder research for "${companyName}" is done and ready for your review. Open the listing's Builder Profile in the dashboard to publish (or reject) it — it stays hidden from buyers until you do.`
      : `🏗️ "${companyName}" ka builder research complete ho gaya hai, review ke liye ready hai. Listing ke Builder Profile mein jaake dashboard se publish (ya reject) karein — jab tak aap nahi karte, buyers ko yeh nahi dikhega.`;

    await enqueueAgentWhatsappSend({ tenantId, phone: owner.phone, messageBody: body });
  } catch (notifyErr) {
    console.error('Failed to notify owner of completed builder research (non-fatal):', notifyErr.message);
  }
}

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

console.log(`[Worker Engine] Initializing Builder Due Diligence Researcher...`);

const builderDueDiligenceWorker = new Worker('builder-due-diligence', async (job) => {
  if (job.name !== 'research') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on builder-due-diligence, skipping.`);
    return { success: false, skipped: true };
  }

  const { builderProfileId, listingId } = job.data;
  console.log(`[Job ${job.id}] Researching builder profile ${builderProfileId}`);

  const profile = await knex('builder_profiles').where({ id: builderProfileId }).first();
  if (!profile) throw new Error(`Builder profile ${builderProfileId} no longer exists.`);

  await knex('builder_profiles').where({ id: builderProfileId }).update({ research_status: 'researching', updated_at: knex.fn.now() });

  // Best-effort context for the "compare to other developers in the same
  // market" part of the assessment — a plain city/price-band phrase, not
  // structured data the model needs to parse. Missing/failed lookup is
  // non-fatal; research still runs fine without it, just less targeted.
  let marketContext = null;
  if (listingId) {
    try {
      const listing = await knex('listings').where({ id: listingId }).first();
      if (listing) {
        const city = (listing.formatted_address || listing.raw_address || '').split(',').slice(-2, -1)[0]?.trim();
        const priceBand = listing.price != null ? `around ₹${Number(listing.price).toLocaleString('en-IN')}` : null;
        if (city) marketContext = [city, priceBand].filter(Boolean).join(', ');
      }
    } catch (ctxErr) {
      console.error(`[Job ${job.id}] Failed to load market context (non-fatal):`, ctxErr.message);
    }
  }

  try {
    const { claims, rating, possessionRecord } = await generateBuilderClaims({ companyName: profile.company_name, marketContext });

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

      // rating/possessionRecord are already null unless generateBuilderClaims
      // found a real cited source for them (see groundedResearchService.js) —
      // writing null here on a re-research is correct, not data loss: it
      // means this run found no citable rating/track record, same as an
      // empty claims array means no citable claims this time.
      await trx('builder_profiles').where({ id: builderProfileId }).update({
        research_status: 'completed',
        last_researched_at: trx.fn.now(),
        updated_at: trx.fn.now(),
        overall_rating: rating?.value ?? null,
        rating_source_url: rating?.source_url ?? null,
        rating_source_title: rating?.source_title ?? null,
        rating_basis: rating?.basis ?? null,
        rating_is_ai_assessment: rating ? !!rating.isAiAssessment : null,
        possession_delivered_count: possessionRecord?.delivered ?? null,
        possession_total_count: possessionRecord?.total ?? null,
        possession_source_url: possessionRecord?.source_url ?? null,
        possession_source_title: possessionRecord?.source_title ?? null,
      });
    });

    console.log(`[Job ${job.id}] Builder due diligence completed for "${profile.company_name}": ${claims.length} cited claims, rating=${rating?.value ?? 'none'}, possession=${possessionRecord ? `${possessionRecord.delivered}/${possessionRecord.total}` : 'none'}.`);

    // Research done + persisted above — now tell the owner there's
    // something waiting for their review/publish decision (see file header
    // for why this worker itself never auto-publishes).
    const listingForNotify = listingId ? await knex('listings').where({ id: listingId }).first() : null;
    if (listingForNotify?.tenant_id) {
      await notifyOwnerBuilderProfileNeedsReview(knex, {
        tenantId: listingForNotify.tenant_id,
        companyName: profile.company_name,
        listing: listingForNotify,
      });
    }

    return { success: true, claimCount: claims.length, hasRating: !!rating, hasPossessionRecord: !!possessionRecord };
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
