// src/controllers/callEnquiryController.js
//
// Read endpoints for call_enquiries (see callEnquiryService.js and the
// 20261008_01_call_enquiries migration): what each inbound AI-call buyer
// asked for, how many listings matched, and where the WhatsApp follow-up
// stands. Two audiences:
//   - a dealer sees enquiries from calls on their own AI-calling number
//   - super-admin sees everything, including calls on the shared Plotraa
//     line (tenant_id NULL), which belong to no single dealer.

const ENQUIRY_COLUMNS = [
  'e.id', 'e.provider_call_id', 'e.caller_phone', 'e.whatsapp_phone', 'e.buyer_name',
  'e.intent', 'e.property_type', 'e.area', 'e.budget_text', 'e.size_text', 'e.timeline_text',
  'e.whatsapp_consent', 'e.summary', 'e.recording_url', 'e.match_count',
  'e.whatsapp_status', 'e.template_sent_at', 'e.listings_sent_at',
  'e.call_started_at', 'e.created_at', 'e.lead_id',
];

function parsePaging(query) {
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  return { limit, offset };
}

/**
 * GET /api/v1/dashboard/ops/call-enquiries
 * Enquiries captured from inbound AI calls on this dealer's number.
 */
async function getCallEnquiries(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;
  const { limit, offset } = parsePaging(req.query);

  try {
    const enquiries = await knex('call_enquiries as e')
      .select(ENQUIRY_COLUMNS)
      .where('e.tenant_id', tenant_id)
      .whereNot('e.whatsapp_status', 'not_an_enquiry')
      .orderBy('e.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    res.json({ enquiries });
  } catch (err) {
    console.error('Failed to fetch call enquiries:', err);
    res.status(500).json({ error: { code: 'CALL_ENQUIRIES_FETCH_FAILED', message: 'Could not load call enquiries.' } });
  }
}

/**
 * GET /api/v1/admin/call-enquiries?days=30&status=template_sent
 * Every enquiry across the platform + a count per WhatsApp status, so a
 * stuck stage (e.g. everything sitting at skipped_no_template) is visible
 * at a glance.
 */
async function getCallEnquiriesAdmin(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const since = knex.raw(`NOW() - INTERVAL '${days} days'`);
  const { limit, offset } = parsePaging(req.query);

  try {
    let listQuery = knex('call_enquiries as e')
      .leftJoin('tenants as t', 'e.tenant_id', 't.id')
      .select([...ENQUIRY_COLUMNS, 'e.tenant_id', 't.business_name as tenant_business_name'])
      .where('e.created_at', '>=', since)
      .orderBy('e.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    if (req.query.status) listQuery = listQuery.andWhere('e.whatsapp_status', String(req.query.status));

    const [enquiries, statusRows] = await Promise.all([
      listQuery,
      knex('call_enquiries')
        .where('created_at', '>=', since)
        .groupBy('whatsapp_status')
        .select('whatsapp_status')
        .count('id as count'),
    ]);

    const byStatus = {};
    for (const row of statusRows) byStatus[row.whatsapp_status] = Number(row.count);

    res.json({ success: true, days, byStatus, enquiries });
  } catch (err) {
    console.error('Failed to fetch call enquiries (admin):', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch call enquiries.' } });
  }
}

module.exports = { getCallEnquiries, getCallEnquiriesAdmin };
