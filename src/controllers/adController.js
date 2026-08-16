/**
 * Public-facing ad serving + telemetry. These are direct-sold display
 * campaigns (interior designers, home loan providers, etc.) shown on
 * property pages across every tenant — not tenant-owned data, no auth.
 */

/**
 * GET /api/v1/public/ads/serve?position=calculator_result&targetCity=Ludhiana
 */
async function fetchTargetedAdPlacements(req, res) {
  const knex = req.app.get('db');
  // BUG FIXED: original draft destructured from a bare `query` identifier
  // that doesn't exist in this scope — it needs to come from `req.query`.
  const { targetCity, interfacePosition } = req.query;

  try {
    const queryBuilder = knex('ad_placements')
      .where('is_active', true)
      .andWhere('active_from', '<=', knex.fn.now())
      .andWhere('active_to', '>=', knex.fn.now());

    if (interfacePosition) {
      queryBuilder.andWhere({ position: interfacePosition });
    }

    if (targetCity) {
      queryBuilder.andWhere(function () {
        this.where({ city_filter: targetCity }).orWhereNull('city_filter');
      });
    }

    const matchedCampaigns = await queryBuilder
      .select('id', 'advertiser_name', 'position', 'image_url', 'click_url')
      .orderBy('created_at', 'desc');

    return res.status(200).json({ success: true, ads: matchedCampaigns });
  } catch (error) {
    console.error('Ad serving failed:', error.message);
    return res.status(500).json({
      error: { code: 'AD_FETCH_FAILED', message: 'Failed to load matching ads.' }
    });
  }
}

/**
 * POST /api/v1/public/ads/:id/event
 * Body: { eventType: 'impression' | 'click' | 'lead', uniqueSessionRef? }
 */
async function recordAdMetricEvent(req, res) {
  const knex = req.app.get('db');
  const { id } = req.params;
  const { eventType, uniqueSessionRef = null } = req.body;

  if (!['impression', 'click', 'lead'].includes(eventType)) {
    return res.status(400).json({
      error: { code: 'MALFORMED_METRIC', message: 'eventType must be impression, click, or lead.' }
    });
  }

  try {
    const campaignExists = await knex('ad_placements').where({ id }).first();
    if (!campaignExists) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ad placement not found.' } });
    }

    await knex('ad_events').insert({
      placement_id: id,
      event_type: eventType,
      session_reference: uniqueSessionRef,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ad telemetry insert failed:', error.message);
    return res.status(500).json({
      error: { code: 'TELEMETRY_DROP', message: 'Failed to record ad event.' }
    });
  }
}

module.exports = { fetchTargetedAdPlacements, recordAdMetricEvent };
