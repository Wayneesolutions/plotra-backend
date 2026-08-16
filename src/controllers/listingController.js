const { createListingRecord, enqueueGeoEnrichment, ListingLimitError } = require('../services/listingService');

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

/**
 * PATCH /api/v1/dashboard/listings/:id
 * Edits an existing listing's fields and/or status (active/inactive/sold).
 * Fixes gap: agents previously had no way to correct a price, description,
 * or take a stale listing offline without engineering intervention — only
 * Copy Link, Photos, and Trace existed on a property card.
 *
 * If raw_address changes, the previous geocoded formatted_address/lat/lng
 * are stale and cleared, and a fresh geo-enrichment job is queued — same
 * pipeline createListing already uses — so satellite imagery, landmarks,
 * and map center all recompute for the new address instead of silently
 * keeping the old location.
 */
async function updateListing(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { id } = req.params;
  const { title, raw_address, price, plot_area, property_type, description, status } = req.body;

  const ALLOWED_STATUSES = ['active', 'inactive', 'sold'];
  if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `status must be one of: ${ALLOWED_STATUSES.join(', ')}.` }
    });
  }

  try {
    const existing = await knex('listings').where({ id, tenant_id }).first();
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found.' } });
    }

    const updates = { updated_at: knex.fn.now() };
    if (title !== undefined) updates.title = title.trim();
    if (price !== undefined) updates.price = parseFloat(price);
    if (plot_area !== undefined) updates.plot_area = plot_area ? plot_area.trim() : null;
    if (property_type !== undefined) updates.property_type = property_type.trim();
    if (description !== undefined) updates.description = description ? description.trim() : null;
    if (status !== undefined) updates.status = status;

    const addressChanged = raw_address !== undefined && raw_address.trim() !== existing.raw_address;
    if (addressChanged) {
      updates.raw_address = raw_address.trim();
      updates.formatted_address = null;
      updates.lat = null;
      updates.lng = null;
      // Only auto-flip to pending if the caller didn't explicitly set a status
      // in this same request (e.g. don't override an explicit reactivate/sell).
      if (status === undefined) updates.status = 'pending';
    }

    const [updated] = await knex('listings')
      .where({ id, tenant_id })
      .update(updates)
      .returning(['id', 'title', 'status', 'raw_address', 'public_slug']);

    if (addressChanged) {
      await enqueueGeoEnrichment({ listingId: updated.id, rawAddress: updated.raw_address });
    }

    return res.status(200).json({
      success: true,
      message: addressChanged
        ? 'Listing updated. Re-running location lookup for the new address.'
        : 'Listing updated.',
      listing: updated,
    });
  } catch (error) {
    console.error('Failed to update listing:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update listing.' }
    });
  }
}

/**
 * DELETE /api/v1/dashboard/listings/:id
 * Permanently removes a listing. Cascades to listing_visits and
 * listing_media at the DB level (see FK onDelete('CASCADE') in the Phase 1
 * migration) — leads themselves are NOT deleted (leads only reference
 * tenant_id, not listing_id directly), only the visit history linking a
 * lead to this specific listing. For agents who just want to stop showing
 * a stale listing without losing its analytics history, PATCH status to
 * 'inactive' instead — the frontend's Deactivate button does exactly that.
 */
async function deleteListing(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { id } = req.params;

  try {
    const existing = await knex('listings').where({ id, tenant_id }).first();
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found.' } });
    }

    await knex('listings').where({ id, tenant_id }).del();

    return res.status(200).json({ success: true, message: 'Listing deleted.' });
  } catch (error) {
    console.error('Failed to delete listing:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete listing.' }
    });
  }
}

module.exports = { createListing, getListings, updateListing, deleteListing };