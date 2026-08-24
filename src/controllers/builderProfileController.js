const { Queue } = require('bullmq');

const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  connectTimeout: 3000,
};
const builderDueDiligenceQueue = new Queue('builder-due-diligence', { connection: redisConnection });

function normalizeCompanyName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// How "nearby" and "similar price" are defined for the comparison list on
// mega-project listings. Deliberately generous rather than precise — the
// goal is "other real options a buyer would actually cross-shop", not a
// tight match; too narrow and most listings would show zero comparisons.
const SIMILAR_PROJECT_RADIUS_KM = 5;
const SIMILAR_PROJECT_PRICE_BAND = 0.2; // ±20%
const SIMILAR_PROJECT_LIMIT = 6;

/**
 * Platform-wide (not tenant-scoped — same precedent as builder_profiles
 * itself, see the 20260817_03 migration header) "other projects nearby in
 * the same price range" for a mega-project listing. Buyers cross-shop
 * across dealers, not within one dealer's own catalog, so scoping this to
 * the current listing's tenant would make it far less useful.
 *
 * Only ever includes listings whose OWN builder profile is published —
 * same moderation discipline as everything else here: a builder company
 * name/rating never appears anywhere on the site before a human has
 * explicitly cleared it, comparison lists included.
 */
async function findSimilarProjects(knex, { listingId, lat, lng, price }) {
  if (lat == null || lng == null) return []; // no coordinates, no "nearby" — non-fatal, just skip

  const query = knex('listings as l')
    .join('builder_profiles as bp', 'bp.id', 'l.builder_profile_id')
    .select(
      'l.public_slug', 'l.title', 'l.price', 'l.plot_area', 'l.property_type',
      'bp.company_name', 'bp.overall_rating',
      // Explicit ::float8 casts — lat/lng are numeric columns, and while
      // Postgres's numeric->float8 cast usually resolves fine here, radians()
      // is only ever defined for double precision, so cast explicitly rather
      // than lean on implicit-cast resolution for arithmetic this exact.
      knex.raw(
        `6371 * acos(least(1, greatest(-1,
           cos(radians(?::float8)) * cos(radians(l.lat::float8)) * cos(radians(l.lng::float8) - radians(?::float8))
           + sin(radians(?::float8)) * sin(radians(l.lat::float8))
         ))) AS distance_km`,
        [lat, lng, lat]
      )
    )
    .where('l.status', 'active')
    .where('bp.moderation_status', 'published')
    .whereNotNull('l.lat')
    .whereNotNull('l.lng')
    .whereNot('l.id', listingId);

  if (price != null) {
    query.whereBetween('l.price', [price * (1 - SIMILAR_PROJECT_PRICE_BAND), price * (1 + SIMILAR_PROJECT_PRICE_BAND)]);
  }

  const rows = await query;

  return rows
    .filter((r) => r.distance_km <= SIMILAR_PROJECT_RADIUS_KM)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, SIMILAR_PROJECT_LIMIT)
    .map((r) => ({
      slug: r.public_slug,
      title: r.title,
      price: r.price,
      plot_area: r.plot_area,
      property_type: r.property_type,
      builder_company_name: r.company_name,
      builder_rating: r.overall_rating != null ? Number(r.overall_rating) : null,
      distance_km: Math.round(r.distance_km * 10) / 10,
    }));
}

/**
 * POST /api/v1/dashboard/listings/:id/builder-profile
 * Links a listing to a builder_profiles row, marking it as a mega-project
 * listing. If a profile for this company (by normalized name) already
 * exists, reuses it immediately — no re-research, no wait. Only a brand-new
 * company name triggers the (slower, web-search-backed) research worker.
 */
async function linkOrCreateBuilderProfile(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { id: listingId } = req.params;
  const { companyName } = req.body;

  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'companyName is required.' } });
  }

  try {
    const listing = await knex('listings').where({ id: listingId, tenant_id }).first();
    if (!listing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found.' } });
    }

    const normalizedName = normalizeCompanyName(companyName);
    let profile = await knex('builder_profiles').where({ normalized_name: normalizedName }).first();
    let isNew = false;

    if (!profile) {
      isNew = true;
      [profile] = await knex('builder_profiles')
        .insert({ company_name: companyName.trim(), normalized_name: normalizedName })
        .returning(['id', 'company_name', 'research_status', 'moderation_status']);
    }

    await knex('listings').where({ id: listingId, tenant_id }).update({ builder_profile_id: profile.id, updated_at: knex.fn.now() });

    if (isNew) {
      await builderDueDiligenceQueue.add('research', { builderProfileId: profile.id }, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
      });
    }

    return res.status(200).json({
      success: true,
      message: isNew
        ? 'Builder profile created — research in progress.'
        : 'Listing linked to existing builder profile.',
      builderProfile: profile,
    });
  } catch (error) {
    console.error('Failed to link/create builder profile:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to link builder profile.' } });
  }
}

/**
 * PATCH /api/v1/dashboard/builder-profiles/:id/moderation
 * Owner-only. The single required human sign-off before a builder's
 * AI-researched, cited claims become visible to buyers — see the migration
 * header for why this gate exists and isn't optional.
 */
async function moderateBuilderProfile(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { role, id: userId } = req.user;
  const { id: profileId } = req.params;
  const { status } = req.body;

  const ALLOWED_STATUSES = ['published', 'rejected', 'pending_review'];
  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `status must be one of: ${ALLOWED_STATUSES.join(', ')}.` }
    });
  }
  if (role !== 'owner') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only tenant owners can moderate builder profiles.' } });
  }

  try {
    const [updated] = await knex('builder_profiles')
      .where({ id: profileId })
      .update({
        moderation_status: status,
        moderated_by: userId,
        moderated_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })
      .returning(['id', 'company_name', 'moderation_status']);

    if (!updated) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Builder profile not found.' } });
    }

    return res.status(200).json({ success: true, builderProfile: updated });
  } catch (error) {
    console.error('Failed to moderate builder profile:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update moderation status.' } });
  }
}

/**
 * GET /api/v1/public/listings/:slug/builder-profile
 * Public, no auth. Only ever returns data once a human has explicitly
 * published it — research completing is not the same as being cleared to
 * show buyers (see migration header, safeguard #3).
 */
async function getPublicBuilderProfile(req, res) {
  const knex = req.app.get('db');
  const { slug } = req.params;

  try {
    const listing = await knex('listings')
      .select('id', 'builder_profile_id', 'lat', 'lng', 'price')
      .where({ public_slug: slug })
      .whereIn('status', ['active', 'awaiting_approval'])
      .first();

    if (!listing || !listing.builder_profile_id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No builder profile for this listing.' } });
    }

    const profile = await knex('builder_profiles')
      .select(
        'id', 'company_name', 'rera_registration_ids', 'mca_cin', 'last_researched_at',
        'overall_rating', 'rating_source_url', 'rating_source_title',
        'possession_delivered_count', 'possession_total_count', 'possession_source_url', 'possession_source_title'
      )
      .where({ id: listing.builder_profile_id, moderation_status: 'published' })
      .first();

    if (!profile) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No builder profile for this listing.' } });
    }

    const claims = await knex('builder_profile_claims')
      .select('category', 'claim_text', 'source_url', 'source_title', 'source_published_date', 'source_domain')
      .where({ builder_profile_id: profile.id })
      .orderBy('category', 'asc');

    // Best-effort — a comparison-query failure shouldn't take down the
    // whole builder-profile response (the claims/rating above are the
    // primary content here).
    let similarProjects = [];
    try {
      similarProjects = await findSimilarProjects(knex, {
        listingId: listing.id, lat: listing.lat, lng: listing.lng, price: listing.price,
      });
    } catch (simErr) {
      console.error('Failed to compute similar projects (non-fatal):', simErr.message);
    }

    return res.status(200).json({ success: true, builderProfile: profile, claims, similarProjects });
  } catch (error) {
    console.error('Failed to fetch public builder profile:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load builder profile.' } });
  }
}

module.exports = { linkOrCreateBuilderProfile, moderateBuilderProfile, getPublicBuilderProfile };
