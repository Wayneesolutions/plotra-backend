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
    const cityScope = function () {
      this.where({ city_filter: targetCity }).orWhereNull('city_filter');
    };

    // 1. Paid campaigns running right now.
    const queryBuilder = knex('ad_placements')
      .where('is_active', true)
      .andWhere('is_default', false)
      .andWhere('active_from', '<=', knex.fn.now())
      .andWhere('active_to', '>=', knex.fn.now());

    if (interfacePosition) {
      queryBuilder.andWhere({ position: interfacePosition });
    }

    if (targetCity) {
      queryBuilder.andWhere(cityScope);
    }

    let matchedCampaigns = await queryBuilder
      .select('id', 'advertiser_name', 'position', 'image_url', 'click_url', 'is_default')
      .orderBy('created_at', 'desc');

    // 2. Nothing paid for this slot → fall back to its default (house) ad,
    //    so slots like calculator_result / listing_footer are never empty.
    //    Defaults ignore the campaign window; only is_active switches them off.
    if (matchedCampaigns.length === 0 && interfacePosition) {
      const defaultQuery = knex('ad_placements')
        .where({ is_active: true, is_default: true, position: interfacePosition });
      if (targetCity) defaultQuery.andWhere(cityScope);

      matchedCampaigns = await defaultQuery
        .select('id', 'advertiser_name', 'position', 'image_url', 'click_url', 'is_default')
        .limit(1);
    }

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
