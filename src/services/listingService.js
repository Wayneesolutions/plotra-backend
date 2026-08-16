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
}) {
  if (!title || !rawAddress || !price || !propertyType) {
    const err = new Error('Title, raw address, price, and property type are required fields.');
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
      price: parseFloat(price),
      plot_area: plotArea ? plotArea.trim() : null,
      property_type: propertyType.trim(),
      description: description ? description.trim() : null,
      public_slug: publicSlug,
      status: 'pending' // Remains 'pending' until the background geocoder confirms coordinates
    })
    .returning(['id', 'title', 'public_slug', 'status']);

  await geoEnrichmentQueue.add('enrich-property-coords', {
    listingId: newListing.id,
    rawAddress: rawAddress.trim(),
    draftId, // undefined for dashboard-created listings — geoEnrichmentWorker treats that as a no-op
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });

  return newListing;
}

module.exports = { createListingRecord, ListingLimitError };
