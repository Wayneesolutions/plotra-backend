// src/controllers/analyticsController.js
const { computeLeadScore } = require('../utils/leadScoring');
/**
 * Compiles aggregated engagement metrics for the active corporate tenant dashboard.
 * Delivers top-level KPIs and individual real estate asset conversion matrices.
 */
async function getDashboardAnalytics(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user; // Enforced via authGuard middleware

  try {
    // 1. Fetch High-Level Aggregated KPI Performance Parameters
    const totalListings = await knex('listings')
      .where({ tenant_id })
      .count('id as count')
      .first();

    const totalLeads = await knex('leads')
      .where({ tenant_id })
      .count('id as count')
      .first();

    const totalImpressions = await knex('listing_visits')
      .join('listings', 'listing_visits.listing_id', 'listings.id')
      .where('listings.tenant_id', tenant_id)
      .count('listing_visits.id as count')
      .first();

    // 2. Compute Individual Property Performance Matrices
    const propertyPerformance = await knex('listings')
      .leftJoin('listing_visits', 'listings.id', 'listing_visits.listing_id')
      .leftJoin('leads', function() {
        this.on('listings.tenant_id', '=', 'leads.tenant_id')
            .andOn('listing_visits.lead_id', '=', 'leads.id');
      })
      .select(
        'listings.id',
        'listings.title',
        'listings.status',
        'listings.price',
        knex.raw('COUNT(DISTINCT listing_visits.id) as total_views'),
        knex.raw('COUNT(DISTINCT leads.id) as converted_leads')
      )
      .where('listings.tenant_id', tenant_id)
      .groupBy('listings.id', 'listings.title', 'listings.status', 'listings.price')
      .orderBy('total_views', 'desc');

    // 3. Extract Recent Core Conversion Timeline Feed
    const recentLeadsFeed = await knex('leads')
      .select('id', 'name', 'phone', 'source', 'status', 'created_at')
      .where({ tenant_id })
      .orderBy('created_at', 'desc')
      .limit(5);

    const scoredRecentLeads = await Promise.all(
      recentLeadsFeed.map(async (lead) => ({
        ...lead,
        score: await computeLeadScore(lead.id, knex)
      }))
    );

    // 4. Return clean telemetry package structure
    return res.status(200).json({
      success: true,
      summary: {
        activeInventory: parseInt(totalListings.count || 0),
        capturedLeads: parseInt(totalLeads.count || 0),
        totalStorefrontViews: parseInt(totalImpressions.count || 0),
        overallConversionRate: totalImpressions.count > 0 
          ? parseFloat(((totalLeads.count / totalImpressions.count) * 100).toFixed(2)) 
          : 0
      },
      propertyPerformance,
      recentLeads: scoredRecentLeads
    });

  } catch (error) {
    console.error('Failure compiling multi-tenant dashboard analytics framework:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to safely aggregate enterprise telemetry sets.' }
    });
  }
}

module.exports = { getDashboardAnalytics };