// src/controllers/supportRequestController.js
//
// Super-admin "Support" queue (see supportRequestService.js): people the
// Plotraa Assistant flagged as needing a human. The team calls/WhatsApps
// them, then marks the request contacted and finally closed.

const STATUSES = ['open', 'contacted', 'closed'];

function clean(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * GET /api/v1/admin/support-requests?status=open|contacted|closed&limit&offset
 */
async function listSupportRequests(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const { status } = req.query;

  if (status && !STATUSES.includes(String(status))) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `status must be one of ${STATUSES.join(', ')}.` } });
  }

  try {
    let q = knex('support_requests as s')
      .leftJoin('tenants as t', 's.tenant_id', 't.id')
      .leftJoin('users as c', 's.contacted_by', 'c.id')
      .select('s.*', 't.business_name as tenant_name', 'c.name as contacted_by_name')
      .orderByRaw("CASE s.status WHEN 'open' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END")
      .orderBy('s.updated_at', 'desc')
      .limit(limit)
      .offset(offset);
    if (status) q = q.where('s.status', String(status));

    const [requests, counts] = await Promise.all([
      q,
      knex('support_requests').groupBy('status').select('status').count('id as count'),
    ]);
    const byStatus = {};
    for (const r of counts) byStatus[r.status] = Number(r.count);
    return res.json({ success: true, byStatus, requests });
  } catch (error) {
    console.error('Failed to list support requests:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list support requests.' } });
  }
}

/**
 * GET /api/v1/admin/support-requests/:id
 * The request plus recent conversation, so whoever calls back knows the
 * context: the assistant chat and, for agents, their listing conversation.
 */
async function getSupportRequest(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  try {
    const request = await knex('support_requests as s')
      .leftJoin('tenants as t', 's.tenant_id', 't.id')
      .where('s.id', req.params.id)
      .first('s.*', 't.business_name as tenant_name');
    if (!request) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Support request not found.' } });

    const assistantChat = await knex('assistant_messages')
      .where({ phone: request.phone })
      .orderBy('created_at', 'desc').limit(30)
      .select('direction', 'body', 'audience', 'action', 'created_at');

    let listingChat = [];
    if (request.user_id) {
      listingChat = await knex('agent_draft_messages as m')
        .join('agent_listing_drafts as d', 'm.draft_id', 'd.id')
        .where('d.user_id', request.user_id)
        .orderBy('m.created_at', 'desc').limit(20)
        .select('m.direction', 'm.body', 'm.created_at');
    }

    return res.json({
      success: true,
      request,
      conversation: [...assistantChat, ...listingChat]
        .filter((m) => m.body)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .slice(-40),
    });
  } catch (error) {
    console.error('Failed to load support request:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load support request.' } });
  }
}

/**
 * PATCH /api/v1/admin/support-requests/:id
 * Body: { status?: 'open'|'contacted'|'closed', admin_notes? }
 */
async function updateSupportRequest(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { status, admin_notes } = req.body || {};

  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `status must be one of ${STATUSES.join(', ')}.` } });
  }
  if (status === undefined && admin_notes === undefined) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Nothing to update.' } });
  }

  try {
    const existing = await knex('support_requests').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Support request not found.' } });

    const patch = { updated_at: knex.fn.now() };
    if (admin_notes !== undefined) patch.admin_notes = clean(admin_notes, 4000);
    if (status !== undefined && status !== existing.status) {
      patch.status = status;
      if (status === 'contacted') {
        patch.contacted_at = knex.fn.now();
        patch.contacted_by = req.user?.id || null;
      }
      if (status === 'closed') patch.closed_at = knex.fn.now();
      if (status === 'open') patch.closed_at = null;
    }

    const [request] = await knex('support_requests').where({ id: req.params.id }).update(patch).returning('*');
    return res.json({ success: true, request });
  } catch (error) {
    console.error('Failed to update support request:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update support request.' } });
  }
}

module.exports = { listSupportRequests, getSupportRequest, updateSupportRequest, STATUSES };
