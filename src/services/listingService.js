const crypto = require('crypto');
const { Queue } = require('bullmq');

// Same fail-fast rationale as the original listingController.js — this is a
// job *producer* (called from an HTTP request or a BullMQ worker handler),
// not the worker that consumes the job, so it shouldn't hang indefinitely
// on a Redis blip.
const geoEnrichmentQueue = new Queue('geo-enrichment', {
  connection: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 3000,
  }
});

class ListingLimitError extends Error {
  constructor(message, plan) {
    super(message);
    this.name = 'ListingLimitError';
    this.plan = plan;
  }
}

/**
 * Validates a proposed listings.assigned_agent_id — per-listing WhatsApp
 * attribution (a specific team member's number shown to buyers on this
 * listing, instead of the tenant's default) only makes sense for a tenant
 * with more than one WhatsApp number to assign FROM in the first place.
 *
 * Part 2, build-order item 7 — re-pointed at plans.max_whatsapp_numbers
 * (> 1) instead of the old plans.multi_agent_whatsapp boolean, per the
 * brief: "needs re-pointing at the new Tier 2/3 flags instead of being
 * rebuilt." multi_agent_whatsapp still exists as a column (not dropped —
 * a separate, later cleanup, not part of this re-point) but is no longer
 * what's checked here. Defaults to 1 if a plan somehow has no
 * max_whatsapp_numbers value (shouldn't happen post-20260825_01, which
 * backfills 1 onto every existing plan) — never treats "unknown" as
 * "unlimited."
 *
 * The referenced user must actually belong to this tenant. Never silently
 * downgrades an invalid request to null — that would look like it worked
 * when it didn't; callers should surface the thrown ValidationError instead.
 *
 * Returns null for "no assignment" (clears any existing one) without
 * needing the plan check — clearing an assignment is always allowed,
 * same as how a single-number tenant can still see/keep using a listing
 * that already has one from before a downgrade.
 */
async function validateAssignedAgent(knex, { tenantId, plan, assignedAgentId }) {
  if (assignedAgentId === null || assignedAgentId === undefined || assignedAgentId === '') {
    return null;
  }

  if (!plan || (plan.max_whatsapp_numbers ?? 1) <= 1) {
    const err = new Error("Assigning a listing to a specific team member's WhatsApp number requires a plan with more than one WhatsApp number.");
    err.name = 'ValidationError';
    throw err;
  }

  const agentUser = await knex('users').where({ id: assignedAgentId, tenant_id: tenantId }).first();
  if (!agentUser) {
    const err = new Error('The selected team member could not be found on this account.');
    err.name = 'ValidationError';
    throw err;
  }

  return agentUser.id;
}

/**
 * Shared listing-creation logic — extracted from listingController.js's
 * createListing so both the HTTP dashboard route and agentIntakeWorker.js
 * (WhatsApp agent-intake) go through the exact same validation, plan-limit
 * check, and geo-enrichment hand-off, instead of two copies drifting apart.
 *
 * Throws (never writes an HTTP response) so callers decide how to surface
 * failures — the HTTP controller maps errors to res.status(...), the
 * worker sends a WhatsApp message instead.
 *
 * `source`/`draftId`: 'whatsapp' + a draft id makes geoEnrichmentWorker.js
 * gate the listing behind agent approval (status -> 'awaiting_approval')
 * instead of the default immediate 'active'. Dashboard-created listings
 * (source: 'dashboard', draftId: undefined) keep today's behavior unchanged.
 */
async function createListingRecord(knex, {
  tenantId,
  createdBy,
  source = 'dashboard',
  draftId,
  title,
  rawAddress,
  price,
  plotArea,
  propertyType,
  description,
  pincode,
  assignedAgentId,
}) {
  if (!title || !rawAddress || !propertyType) {
    const err = new Error('Title, raw address, and property type are required fields.');
    err.name = 'ValidationError';
    throw err;
  }

  const tenant = await knex('tenants').where({ id: tenantId }).first();
  const plan = await knex('plans').where({ key: tenant.plan }).first();

  if (plan && plan.listing_limit !== null) {
    const [{ count }] = await knex('listings').where({ tenant_id: tenantId }).count('id as count');
    if (parseInt(count, 10) >= plan.listing_limit) {
      throw new ListingLimitError(
        `Your ${plan.label} plan allows up to ${plan.listing_limit} listings. Upgrade your plan to add more.`,
        plan
      );
    }
  }

  const validatedAgentId = await validateAssignedAgent(knex, { tenantId, plan, assignedAgentId });

  const publicSlug = crypto.randomBytes(16).toString('hex');

  const [newListing] = await knex('listings')
    .insert({
      tenant_id: tenantId,
      created_by: createdBy,
      source,
      title: title.trim(),
      raw_address: rawAddress.trim(),
      price: (price !== null && price !== undefined && price !== '') ? parseFloat(price) : null,
      plot_area: plotArea ? plotArea.trim() : null,
      property_type: propertyType.trim(),
      description: description ? description.trim() : null,
      pincode: (typeof pincode === 'string' && /^\d{6}$/.test(pincode.trim())) ? pincode.trim() : null,
      assigned_agent_id: validatedAgentId,
      public_slug: publicSlug,
      status: 'pending' // Remains 'pending' until the background geocoder confirms coordinates
    })
    .returning(['id', 'title', 'public_slug', 'status']);

  await enqueueGeoEnrichment({ listingId: newListing.id, rawAddress: rawAddress.trim(), draftId });

  return newListing;
}

/**
 * Queues (or re-queues, e.g. after an address edit) the geo-enrichment job.
 * Exported so every call site that needs to (re)trigger enrichment —
 * createListingRecord above, listingController.js's updateListing (PATCH),
 * and agentIntakeWorker.js's correction-with-address-change path — shares
 * one Queue instance and one payload shape, instead of copies that can
 * silently drift apart. (This is exactly what happened here: PR #4's
 * updateListing was written against a geoEnrichmentQueue constant that
 * used to live directly in listingController.js — that constant stopped
 * existing once createListing was extracted into this file, leaving
 * updateListing calling an undefined variable. Caught by hand, not by
 * `node --check`, since referencing an undeclared identifier is only a
 * runtime ReferenceError, not a syntax error.)
 */
async function enqueueGeoEnrichment({ listingId, rawAddress, draftId }) {
  await geoEnrichmentQueue.add('enrich-property-coords', {
    listingId,
    rawAddress,
    draftId, // undefined outside the WhatsApp agent-intake flow — geoEnrichmentWorker treats that as a no-op
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
}

module.exports = { createListingRecord, enqueueGeoEnrichment, validateAssignedAgent, ListingLimitError };
