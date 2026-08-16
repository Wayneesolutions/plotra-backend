const { createListingRecord, ListingLimitError } = require('../services/listingService');

/**
 * Inserts a new real estate listing asset safely scoped inside the active
 * tenant space, via the shared listingService (also used by
 * agentIntakeWorker.js for WhatsApp-originated listings — see that file for
 * the source: 'whatsapp' path). Dispatches an asynchronous geocoding and
 * visual aggregation job via BullMQ.
 */
async function createListing(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, id: userId } = req.user;
  const { title, raw_address, price, plot_area, property_type, description } = req.body;

  try {
    const newListing = await createListingRecord(knex, {
      tenantId: tenant_id,
      createdBy: userId,
      source: 'dashboard',
      title,
      rawAddress: raw_address,
      price,
      plotArea: plot_area,
      propertyType: property_type,
      description,
    });

    return res.status(201).json({
      success: true,
      message: 'Base listing asset registered. Geo-enrichment pipeline triggered in the background.',
      listing: {
        id: newListing.id,
        title: newListing.title,
        publicLinkSlug: newListing.public_slug,
        status: newListing.status
      }
    });

  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.message } });
    }
    if (error instanceof ListingLimitError) {
      return res.status(403).json({ error: { code: 'LISTING_LIMIT_REACHED', message: error.message } });
    }
    console.error('Failed to instantiate new transactional property row:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'System failed to write property configuration.' }
    });
  }
}

/**
 * Lists every listing belonging to the current tenant, with a visit_count
 * computed for each — this is what DashboardListings.jsx (Phase 1 UI) calls.
 * Not part of the original Gemini code drop; added here because the UI
 * component depends on it and would otherwise have nothing to render.
 */
async function getListings(req, res) {
  // BUG FIX: this used req.app.get('db') (the raw pool, no tenant context)
  // even though the route already applies tenantTransaction — meaning the
  // SET LOCAL app.current_tenant_id that middleware sets was never actually
  // used by this query. Harmless under the old permissive RLS (allow
  // everything with no context) since the .where({tenant_id}) below still
  // filtered correctly at the app layer, but under the new default-deny
  // RLS this would have returned zero rows instead of the tenant's actual
  // listings.
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;

  try {
    const listings = await knex('listings')
      .leftJoin('listing_visits', 'listings.id', 'listing_visits.listing_id')
      .select(
        'listings.id',
        'listings.title',
        'listings.raw_address',
        'listings.formatted_address',
        'listings.lat',
        'listings.lng',
        'listings.price',
        'listings.plot_area',
        'listings.property_type',
        'listings.description',
        'listings.status',
        'listings.public_slug',
        'listings.created_at'
      )
      .count('listing_visits.id as visit_count')
      .where('listings.tenant_id', tenant_id)
      .groupBy(
        'listings.id', 'listings.title', 'listings.raw_address', 'listings.formatted_address',
        'listings.lat', 'listings.lng', 'listings.price', 'listings.plot_area',
        'listings.property_type', 'listings.description', 'listings.status',
        'listings.public_slug', 'listings.created_at'
      )
      .orderBy('listings.created_at', 'desc');

    return res.status(200).json({
      success: true,
      listings: listings.map((l) => ({ ...l, visit_count: parseInt(l.visit_count || 0) }))
    });
  } catch (error) {
    console.error('Failed to fetch tenant listing inventory:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'System failed to load property inventory.' }
    });
  }
}

module.exports = { createListing, getListings };