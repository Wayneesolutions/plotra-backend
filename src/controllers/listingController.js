const crypto = require('crypto');
const { Queue } = require('bullmq');

// Initialize access queue pointing at our background Redis worker instance.
// maxRetriesPerRequest/retryStrategy/connectTimeout: this is a job
// *producer* (adding jobs from an HTTP request), not the worker that
// consumes them — if Redis has a brief outage, a request creating a
// listing should fail fast with a clear error, not hang indefinitely
// waiting for ioredis's default unlimited reconnect retries. The actual
// worker process (geoEnrichmentWorker.js) should and does keep its own
// persistent, long-retry connection — this fix is scoped to producers only.
const geoEnrichmentQueue = new Queue('geo-enrichment', {
  connection: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 3000,
  }
});

/**
 * Inserts a new real estate listing asset safely scoped inside the active tenant space.
 * Dispatches an asynchronous geocoding and visual aggregation job via BullMQ.
 */
async function createListing(req, res) {
  const knex = req.dbTrx || req.app.get('db');

  // Extract contextual identity injected previously by our authGuard middleware
  const { tenant_id, id: userId } = req.user;
  
  const { title, raw_address, price, plot_area, property_type, description } = req.body;

  // 1. Structural Parameter Validation Checks
  if (!title || !raw_address || !price || !property_type) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Title, raw address, price, and property type are required fields.' }
    });
  }

  try {
    // FIX (gap #5 — listing limits not enforced): plan limits existed only
    // as a number shown on the pricing page — nothing ever checked a
    // tenant's actual listing count against it, so a starter-plan tenant
    // could create unlimited listings same as an unlimited-plan one.
    const tenant = await knex('tenants').where({ id: tenant_id }).first();
    const plan = await knex('plans').where({ key: tenant.plan }).first();

    if (plan && plan.listing_limit !== null) {
      const [{ count }] = await knex('listings').where({ tenant_id }).count('id as count');
      if (parseInt(count, 10) >= plan.listing_limit) {
        return res.status(403).json({
          error: {
            code: 'LISTING_LIMIT_REACHED',
            message: `Your ${plan.label} plan allows up to ${plan.listing_limit} listings. Upgrade your plan to add more.`,
          },
        });
      }
    }

    // 2. Generate a highly secure, unguessable URL slug (16 random bytes to prevent guessing attacks)
    const publicSlug = crypto.randomBytes(16).toString('hex');

    // 3. Persist the database record wrapped inside our Knex client tracking system
    const [newListing] = await knex('listings')
      .insert({
        tenant_id,
        created_by: userId,
        title: title.trim(),
        raw_address: raw_address.trim(),
        price: parseFloat(price),
        plot_area: plot_area ? plot_area.trim() : null,
        property_type: property_type.trim(),
        description: description ? description.trim() : null,
        public_slug: publicSlug,
        status: 'pending' // Remains 'pending' until the background geocoder confirms coordinates
      })
      .returning(['id', 'title', 'public_slug', 'status']);

    // 4. Offload third-party Google Maps platform API latency to BullMQ task engine
    await geoEnrichmentQueue.add('enrich-property-coords', {
      listingId: newListing.id,
      rawAddress: raw_address.trim()
    }, {
      attempts: 3, // Automatically retry 3 times if Google API spikes or rate limits kick in
      backoff: {
        type: 'exponential',
        delay: 2000 // Start with 2 second backoff floor intervals
      }
    });

    // 5. Send transaction metadata back to the Dashboard UI right away
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
      await geoEnrichmentQueue.add('enrich-property-coords', {
        listingId: updated.id,
        rawAddress: updated.raw_address,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
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