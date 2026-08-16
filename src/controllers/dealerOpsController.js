// src/controllers/dealerOpsController.js
//
// Backs the internal WayneState Pro ops panel (/dashboard/ops in the
// frontend) — the dealer's day-to-day operations view: overview stats,
// the WhatsApp lead inbox, document verification queue, AI voice call
// log, and site visit scheduling. All tenant-scoped, same pattern as
// analyticsController.js / listingController.js: req.dbTrx falls back
// to the raw pool, tenant_id comes from authGuard's req.user.

/**
 * GET /api/v1/dashboard/ops/overview
 * Snapshot cards + a merged 24h activity feed across unlocks, calls,
 * new leads, and document submissions — mirrors the ops dashboard's
 * "Overview" screen.
 */
async function getOverview(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;

  try {
    const [{ count: activeListings }] = await knex('listings')
      .where({ tenant_id, status: 'active' })
      .count('id as count');

    const [{ count: newLeadsToday }] = await knex('leads')
      .where({ tenant_id })
      .whereRaw('created_at >= CURRENT_DATE')
      .count('id as count');

    const [{ count: pendingVerifications }] = await knex('documents')
      .where({ tenant_id, status: 'pending' })
      .count('id as count');

    const [{ count: flaggedVerifications }] = await knex('documents')
      .where({ tenant_id, status: 'flagged' })
      .count('id as count');

    const [{ count: unlocksThisWeek }] = await knex('address_unlocks')
      .where({ tenant_id })
      .whereRaw("unlocked_at >= date_trunc('week', CURRENT_DATE)")
      .count('id as count');

    const [{ count: upcomingVisits }] = await knex('site_visits')
      .where({ tenant_id, status: 'scheduled' })
      .whereRaw('scheduled_for BETWEEN NOW() AND NOW() + interval \'7 days\'')
      .count('id as count');

    // Merge four event sources into one feed, newest first. Small tenant
    // volumes make a UNION + app-side sort simpler and fast enough than a
    // materialized activity_log table for now.
    const [unlocks, calls, leads, docs] = await Promise.all([
      knex('address_unlocks as u')
        .join('listings as l', 'u.listing_id', 'l.id')
        .leftJoin('leads as ld', 'u.lead_id', 'ld.id')
        .select(
          knex.raw("'unlock' as kind"),
          'u.unlocked_at as occurred_at',
          'l.id as listing_id',
          'l.title as listing_title',
          'ld.name as actor_name'
        )
        .where('u.tenant_id', tenant_id)
        .orderBy('u.unlocked_at', 'desc')
        .limit(10),
      knex('ai_voice_calls as c')
        .leftJoin('listings as l', 'c.listing_id', 'l.id')
        .select(
          knex.raw("'call' as kind"),
          'c.called_at as occurred_at',
          'c.listing_id',
          'l.title as listing_title',
          'c.language',
          'c.outcome'
        )
        .where('c.tenant_id', tenant_id)
        .orderBy('c.called_at', 'desc')
        .limit(10),
      knex('leads')
        .select(
          knex.raw("'lead' as kind"),
          'created_at as occurred_at',
          'name as actor_name',
          'source'
        )
        .where({ tenant_id })
        .orderBy('created_at', 'desc')
        .limit(10),
      knex('documents as d')
        .join('listings as l', 'd.listing_id', 'l.id')
        .select(
          knex.raw("'document' as kind"),
          'd.submitted_at as occurred_at',
          'l.id as listing_id',
          'l.title as listing_title',
          'd.document_type'
        )
        .where('d.tenant_id', tenant_id)
        .orderBy('d.submitted_at', 'desc')
        .limit(10),
    ]);

    const activity = [...unlocks, ...calls, ...leads, ...docs]
      .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
      .slice(0, 15);

    res.json({
      stats: {
        active_listings: parseInt(activeListings, 10),
        new_leads_today: parseInt(newLeadsToday, 10),
        pending_verifications: parseInt(pendingVerifications, 10),
        flagged_verifications: parseInt(flaggedVerifications, 10),
        unlocks_this_week: parseInt(unlocksThisWeek, 10),
        upcoming_visits: parseInt(upcomingVisits, 10),
      },
      activity,
    });
  } catch (err) {
    res.status(500).json({ error: { code: 'OVERVIEW_FETCH_FAILED', message: 'Could not load overview.' } });
  }
}

/**
 * GET /api/v1/dashboard/ops/leads
 * Lead list for the inbox's left pane. ?status= filters, ?listing_id= filters.
 */
async function getLeads(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { status, listing_id } = req.query;

  try {
    let q = knex('leads')
      .select('id', 'name', 'phone', 'email', 'source', 'status', 'assigned_to', 'created_at')
      .where({ tenant_id })
      .orderBy('created_at', 'desc');

    if (status) q = q.andWhere({ status });
    if (listing_id) {
      q = q.whereIn('id', function () {
        this.select('lead_id').from('whatsapp_threads').where({ tenant_id, listing_id });
      });
    }

    const leads = await q;
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: { code: 'LEADS_FETCH_FAILED', message: 'Could not load leads.' } });
  }
}

/**
 * GET /api/v1/dashboard/ops/leads/:id/messages
 * Full WhatsApp thread + messages for the inbox's right pane.
 */
async function getLeadMessages(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { id } = req.params;

  try {
    const thread = await knex('whatsapp_threads')
      .where({ tenant_id, lead_id: id })
      .orderBy('created_at', 'desc')
      .first();

    if (!thread) return res.json({ thread: null, messages: [] });

    const messages = await knex('whatsapp_messages')
      .where({ thread_id: thread.id })
      .orderBy('sent_at', 'asc');

    res.json({ thread, messages });
  } catch (err) {
    res.status(500).json({ error: { code: 'THREAD_FETCH_FAILED', message: 'Could not load conversation.' } });
  }
}

/**
 * GET /api/v1/dashboard/ops/documents
 * Verification queue. ?status= filters (pending/verified/flagged/rejected).
 */
async function getDocuments(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { status } = req.query;

  try {
    let q = knex('documents as d')
      .join('listings as l', 'd.listing_id', 'l.id')
      .leftJoin('leads as ld', 'd.lead_id', 'ld.id')
      .select(
        'd.id', 'd.document_type', 'd.file_url', 'd.status',
        'd.verified_by', 'd.verification_notes', 'd.submitted_at', 'd.verified_at',
        'l.id as listing_id', 'l.title as listing_title',
        'ld.name as buyer_name'
      )
      .where('d.tenant_id', tenant_id)
      .orderBy('d.submitted_at', 'desc');

    if (status) q = q.andWhere('d.status', status);

    const documents = await q;
    res.json({ documents });
  } catch (err) {
    res.status(500).json({ error: { code: 'DOCUMENTS_FETCH_FAILED', message: 'Could not load documents.' } });
  }
}

/**
 * PATCH /api/v1/dashboard/ops/documents/:id
 * Verify / flag / reject a document, with optional notes.
 */
async function updateDocumentStatus(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, name: verifierName } = req.user;
  const { id } = req.params;
  const { status, verification_notes } = req.body;

  const ALLOWED = ['pending', 'verified', 'flagged', 'rejected'];
  if (!ALLOWED.includes(status)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `status must be one of ${ALLOWED.join(', ')}` } });
  }

  try {
    const [doc] = await knex('documents')
      .where({ id, tenant_id })
      .update({
        status,
        verification_notes: verification_notes ?? knex.raw('verification_notes'),
        verified_by: status === 'verified' ? verifierName : knex.raw('verified_by'),
        verified_at: status === 'verified' ? knex.fn.now() : knex.raw('verified_at'),
        updated_at: knex.fn.now(),
      })
      .returning('*');

    if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: { code: 'DOCUMENT_UPDATE_FAILED', message: 'Could not update document.' } });
  }
}

/**
 * GET /api/v1/dashboard/ops/calls
 * AI voice call log.
 */
async function getCalls(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;

  try {
    const calls = await knex('ai_voice_calls as c')
      .leftJoin('leads as ld', 'c.lead_id', 'ld.id')
      .leftJoin('listings as l', 'c.listing_id', 'l.id')
      .select(
        'c.id', 'c.direction', 'c.provider', 'c.language', 'c.outcome',
        'c.duration_seconds', 'c.recording_url', 'c.transcript_summary', 'c.called_at',
        'ld.name as lead_name', 'ld.phone as lead_phone',
        'l.id as listing_id', 'l.title as listing_title'
      )
      .where('c.tenant_id', tenant_id)
      .orderBy('c.called_at', 'desc');

    res.json({ calls });
  } catch (err) {
    res.status(500).json({ error: { code: 'CALLS_FETCH_FAILED', message: 'Could not load call log.' } });
  }
}

/**
 * GET /api/v1/dashboard/ops/visits
 * Scheduled site visits.
 */
async function getVisits(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;

  try {
    const visits = await knex('site_visits as v')
      .join('listings as l', 'v.listing_id', 'l.id')
      .join('leads as ld', 'v.lead_id', 'ld.id')
      .leftJoin('users as u', 'v.assigned_agent_id', 'u.id')
      .select(
        'v.id', 'v.scheduled_for', 'v.status', 'v.notes',
        'l.id as listing_id', 'l.title as listing_title',
        'ld.name as lead_name', 'ld.phone as lead_phone',
        'u.name as agent_name'
      )
      .where('v.tenant_id', tenant_id)
      .orderBy('v.scheduled_for', 'asc');

    res.json({ visits });
  } catch (err) {
    res.status(500).json({ error: { code: 'VISITS_FETCH_FAILED', message: 'Could not load site visits.' } });
  }
}

/**
 * PATCH /api/v1/dashboard/ops/visits/:id
 * Mark a visit completed / cancelled / no_show, or reschedule.
 */
async function updateVisit(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { id } = req.params;
  const { status, scheduled_for, notes } = req.body;

  const ALLOWED = ['scheduled', 'completed', 'cancelled', 'no_show'];
  if (status && !ALLOWED.includes(status)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `status must be one of ${ALLOWED.join(', ')}` } });
  }

  try {
    const update = { updated_at: knex.fn.now() };
    if (status) update.status = status;
    if (scheduled_for) update.scheduled_for = scheduled_for;
    if (notes !== undefined) update.notes = notes;

    const [visit] = await knex('site_visits').where({ id, tenant_id }).update(update).returning('*');
    if (!visit) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Visit not found.' } });
    res.json({ visit });
  } catch (err) {
    res.status(500).json({ error: { code: 'VISIT_UPDATE_FAILED', message: 'Could not update visit.' } });
  }
}

module.exports = {
  getOverview,
  getLeads,
  getLeadMessages,
  getDocuments,
  updateDocumentStatus,
  getCalls,
  getVisits,
  updateVisit,
};
