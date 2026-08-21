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

module.exports = { createListingRecord, enqueueGeoEnrichment, ListingLimitError };
