/**
 * Super-admin management of ad placements. Mounted under /api/v1/admin,
 * which already applies authGuard + adminGuard in routes/admin.js — every
 * function here can assume req.user.role === 'super_admin'.
 */

const VALID_POSITIONS = ['calculator_result', 'listing_sidebar', 'listing_footer'];
const VALID_REVENUE_MODELS = ['cpl', 'flat_fee'];

/**
 * GET /api/v1/admin/ads
 * Lists every ad placement (active and inactive) with lifetime event counts.
 */
async function listAdPlacements(req, res) {
  const knex = req.dbTrx || req.app.get('db');

  try {
    const placements = await knex('ad_placements')
      .select(
        'ad_placements.*',
        knex.raw("count(ad_events.id) filter (where ad_events.event_type = 'impression')::int as impressions"),
        knex.raw("count(ad_events.id) filter (where ad_events.event_type = 'click')::int as clicks")
      )
      .leftJoin('ad_events', 'ad_placements.id', 'ad_events.placement_id')
      .groupBy('ad_placements.id')
      .orderBy('ad_placements.created_at', 'desc');

    return res.json({ success: true, placements });
  } catch (error) {
    console.error('Failed to list ad placements:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch ad placements.' } });
  }
}

/**
 * POST /api/v1/admin/ads
 * Creates a new ad placement.
 */
async function createAdPlacement(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const {
    advertiser_name,
    position,
    image_url,
    click_url,
    city_filter = null,
    revenue_model = 'flat_fee',
    active_from,
    active_to,
  } = req.body;

  if (!advertiser_name || !position || !image_url || !click_url || !active_from || !active_to) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'advertiser_name, position, image_url, click_url, active_from, and active_to are required.',
      },
    });
  }

  if (!VALID_POSITIONS.includes(position)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `position must be one of: ${VALID_POSITIONS.join(', ')}.` }
    });
  }

  if (!VALID_REVENUE_MODELS.includes(revenue_model)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `revenue_model must be one of: ${VALID_REVENUE_MODELS.join(', ')}.` }
    });
  }

  if (new Date(active_to) <= new Date(active_from)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'active_to must be after active_from.' }
    });
  }

  try {
    const [placement] = await knex('ad_placements')
      .insert({
        advertiser_name: advertiser_name.trim(),
        position,
        image_url: image_url.trim(),
        click_url: click_url.trim(),
        city_filter: city_filter ? city_filter.trim() : null,
        revenue_model,
        active_from,
        active_to,
        is_active: true,
      })
      .returning('*');

    return res.status(201).json({ success: true, placement });
  } catch (error) {
    console.error('Failed to create ad placement:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create ad placement.' } });
  }
}

/**
 * PATCH /api/v1/admin/ads/:id
 * Partial update — most commonly toggling is_active, but accepts any
 * editable field (e.g. extending active_to, fixing a typo'd click_url).
 */
async function updateAdPlacement(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const allowedFields = [
    'advertiser_name', 'position', 'image_url', 'click_url',
    'city_filter', 'revenue_model', 'active_from', 'active_to', 'is_active',
  ];

  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No valid fields provided to update.' } });
  }

  if (updates.position && !VALID_POSITIONS.includes(updates.position)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `position must be one of: ${VALID_POSITIONS.join(', ')}.` }
    });
  }

  if (updates.revenue_model && !VALID_REVENUE_MODELS.includes(updates.revenue_model)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `revenue_model must be one of: ${VALID_REVENUE_MODELS.join(', ')}.` }
    });
  }

  updates.updated_at = knex.fn.now();

  try {
    const existing = await knex('ad_placements').where({ id }).first();
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ad placement not found.' } });
    }

    const [placement] = await knex('ad_placements').where({ id }).update(updates).returning('*');
    return res.json({ success: true, placement });
  } catch (error) {
    console.error('Failed to update ad placement:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update ad placement.' } });
  }
}

module.exports = { listAdPlacements, createAdPlacement, updateAdPlacement };
