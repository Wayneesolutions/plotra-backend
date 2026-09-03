// src/controllers/adminMarketplaceLeadsController.js
//
// Super-admin view of marketplace_lead_deliveries (see the
// 20260903_01_marketplace_buyer_search migration and
// buyerSearchService.js). Phase 1 is tracking only — this endpoint reads
// counts for visibility; nothing here charges a dealer. It exists so
// Phase 2 (actual per-lead billing) has real numbers to design against
// instead of guessing.
async function getMarketplaceLeadsSummary(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const since = knex.raw(`NOW() - INTERVAL '${days} days'`);

  try {
    const perTenant = await knex('marketplace_lead_deliveries')
      .join('tenants', 'marketplace_lead_deliveries.tenant_id', 'tenants.id')
      .where('marketplace_lead_deliveries.delivered_at', '>=', since)
      .groupBy('tenants.id', 'tenants.business_name')
      .select('tenants.id as tenant_id', 'tenants.business_name as tenant_business_name')
      .count('marketplace_lead_deliveries.id as lead_count')
      .orderBy('lead_count', 'desc');

    const totalRow = await knex('marketplace_lead_deliveries')
      .where('delivered_at', '>=', since)
      .count('id as count')
      .first();

    const recent = await knex('marketplace_lead_deliveries')
      .join('tenants', 'marketplace_lead_deliveries.tenant_id', 'tenants.id')
      .join('listings', 'marketplace_lead_deliveries.listing_id', 'listings.id')
      .where('marketplace_lead_deliveries.delivered_at', '>=', since)
      .select(
        'marketplace_lead_deliveries.id',
        'marketplace_lead_deliveries.buyer_phone',
        'marketplace_lead_deliveries.matched_query',
        'marketplace_lead_deliveries.delivered_at',
        'tenants.business_name as tenant_business_name',
        'listings.title as listing_title',
        'listings.public_slug as listing_public_slug'
      )
      .orderBy('marketplace_lead_deliveries.delivered_at', 'desc')
      .limit(50);

    return res.json({
      success: true,
      days,
      totalLeads: Number(totalRow.count),
      perTenant: perTenant.map((row) => ({ ...row, lead_count: Number(row.lead_count) })),
      recent,
    });
  } catch (error) {
    console.error('Failed to fetch marketplace leads summary:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch marketplace leads summary.' }
    });
  }
}

module.exports = { getMarketplaceLeadsSummary };
