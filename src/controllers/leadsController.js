const { computeLeadScore } = require('../utils/leadScoring');

const ALLOWED_STATUSES = ['new', 'contacted', 'qualified', 'closed', 'lost'];

/**
 * GET /api/v1/dashboard/leads
 *
 * Fixes the gap identified in the July 2026 product audit: the `leads` table
 * and computeLeadScore() already existed and were already populated by every
 * WhatsApp callback request on the public listing page (see
 * publicListingController.capturePublicLead), but nothing in the dashboard
 * ever queried or rendered them. Leads were being captured and then
 * permanently invisible to the agent who needed to act on them.
 *
 * Optional ?status=new|contacted|qualified|closed|lost filters the list;
 * omitted or 'all' returns everything for the tenant.
 */
async function getLeads(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role, id: userId } = req.user;
  const { status } = req.query;

  try {
    let query = knex('leads')
      .where('leads.tenant_id', tenant_id)
      .orderBy('leads.created_at', 'desc');

    if (role === 'agent') {
      // Agents see only leads that came from listings assigned to them —
      // a buyer who tapped "callback" on another agent's listing doesn't
      // belong in this agent's inbox. Owner sees everything (no filter).
      // A sub-dealer also sees leads their dealer handed to them (assigned_to).
      query = query
        .leftJoin('listing_visits', 'listing_visits.lead_id', 'leads.id')
        .leftJoin('listings', 'listings.id', 'listing_visits.listing_id')
        .where((b) => b.where('listings.assigned_agent_id', userId).orWhere('leads.assigned_to', userId))
        .distinct(
          'leads.id', 'leads.name', 'leads.phone', 'leads.email',
          'leads.source', 'leads.status', 'leads.created_at', 'leads.details', 'leads.assigned_to'
        );
    } else {
      query = query.select('leads.id', 'leads.name', 'leads.phone', 'leads.email', 'leads.source', 'leads.status', 'leads.created_at', 'leads.details', 'leads.assigned_to');
    }

    if (status && status !== 'all') {
      if (!ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: `Invalid status filter. Use one of: ${ALLOWED_STATUSES.join(', ')}.` }
        });
      }
      query = query.andWhere('leads.status', status);
    }

    const leads = await query;

    // Enrich each lead with its score and the most recent listing it engaged with,
    // so the agent can see *what* the buyer is interested in without hunting.
    const enriched = await Promise.all(
      leads.map(async (lead) => {
        const [score, lastVisit] = await Promise.all([
          computeLeadScore(lead.id, knex),
          knex('listing_visits')
            .join('listings', 'listing_visits.listing_id', 'listings.id')
            .where({ 'listing_visits.lead_id': lead.id })
            .select('listings.id as listing_id', 'listings.title', 'listings.raw_address', 'listings.public_slug')
            .orderBy('listing_visits.visited_at', 'desc')
            .first(),
        ]);

        return {
          ...lead,
          score,
          listing: lastVisit
            ? {
                id: lastVisit.listing_id,
                title: lastVisit.title,
                address: lastVisit.raw_address,
                publicSlug: lastVisit.public_slug,
              }
            : null,
        };
      })
    );

    // Sort hottest leads first within the returned set — score desc, then most recent.
    enriched.sort((a, b) => b.score - a.score);

    const counts = { all: enriched.length, new: 0, contacted: 0, qualified: 0, closed: 0, lost: 0 };
    for (const lead of enriched) {
      if (counts[lead.status] !== undefined) counts[lead.status] += 1;
    }

    return res.status(200).json({ success: true, leads: enriched, counts });
  } catch (error) {
    console.error('Failed to fetch leads:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch leads.' }
    });
  }
}

/**
 * PATCH /api/v1/dashboard/leads/:id/status
 * Lets an agent mark a lead as contacted/qualified/closed/lost so the inbox
 * is actionable rather than a read-only dump.
 */
async function updateLeadStatus(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { id } = req.params;
  const { status } = req.body || {};

  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}.` }
    });
  }

  try {
    const [updated] = await knex('leads')
      .where({ id, tenant_id })
      .update({ status, updated_at: knex.fn.now() })
      .returning(['id', 'status']);

    if (!updated) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Lead not found for this account.' }
      });
    }

    return res.status(200).json({ success: true, lead: updated });
  } catch (error) {
    console.error('Failed to update lead status:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update lead status.' }
    });
  }
}

/**
 * PATCH /api/v1/dashboard/leads/:id/assign
 * Body: { user_id | null } — the dealer hands a lead to one of their
 * sub-dealers (or takes it back with null). The sub-dealer sees it in their
 * Leads and gets a WhatsApp alert.
 */
async function assignLead(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const { id } = req.params;
  const userId = req.body?.user_id || null;

  if (role !== 'owner') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the dealer can hand out leads.' } });
  }
  try {
    const lead = await knex('leads').where({ id, tenant_id }).first();
    if (!lead) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found for this account.' } });
    let member = null;
    if (userId) {
      member = await knex('users').where({ id: userId, tenant_id }).first('id', 'name', 'phone');
      if (!member) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sub-dealer not found in your team.' } });
    }
    await knex('leads').where({ id, tenant_id }).update({ assigned_to: userId, updated_at: knex.fn.now() });

    if (member?.phone && member.id !== req.user.id) {
      try {
        await require('../services/agentMessagingService').enqueueAgentWhatsappSend({
          tenantId: tenant_id,
          phone: member.phone,
          messageBody: [
            '🔔 *Naya lead aapke liye!*',
            `👤 ${lead.name || 'Customer'}  📞 ${lead.phone || '-'}`,
            lead.details ? `🏠 ${lead.details}` : null,
            'Jaldi contact karein. Ye panel mein Leads mein bhi hai.',
          ].filter(Boolean).join('\n'),
        });
      } catch (err) {
        console.error('Sub-dealer lead alert failed (non-fatal):', err.message);
      }
    }
    return res.status(200).json({ success: true, lead: { id, assigned_to: userId } });
  } catch (error) {
    console.error('Failed to assign lead:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to assign the lead.' } });
  }
}

module.exports = { getLeads, updateLeadStatus, assignLead };
