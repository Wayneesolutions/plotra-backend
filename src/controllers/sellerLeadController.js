// src/controllers/sellerLeadController.js
//
// "Sell your property" leads (see migration 20261015_01). The public site
// submits them; super-admin reviews and forwards each to any dealer. On
// assignment a regular `leads` row is created for the dealer so it appears
// in their existing leads dashboard.

const { normalizePhone } = require('../utils/phone');
const { dealerIsActive } = require('../services/trialService');

const enqueueWhatsapp = (...a) => require('../services/agentMessagingService').enqueueAgentWhatsappSend(...a);

/** Pure (unit-tested): one-line summary of what the owner is selling. */
function sellerLeadDetails(lead) {
  const parts = [
    lead.property_type,
    lead.size_text,
    [lead.locality, lead.city].filter(Boolean).join(', ') || null,
    lead.expected_price ? `expected ${lead.expected_price}` : null,
  ].filter(Boolean);
  const text = parts.length ? `Owner selling: ${parts.join(' · ')}` : 'Owner wants to sell a property';
  return lead.description ? `${text}. ${String(lead.description).slice(0, 300)}` : text;
}

/** Pure (unit-tested): the WhatsApp alert a dealer gets for a forwarded lead. */
function buildDealerLeadAlert(lead, { dealerName } = {}) {
  return [
    `🔔 *Naya lead${dealerName ? `, ${dealerName}` : ''}!* Plotraa team ne aapko ek property owner bheja hai.`,
    `👤 ${lead.name || 'Owner'}  📞 ${lead.phone}`,
    `🏠 ${sellerLeadDetails(lead)}`,
    'Jaldi contact karein. Ye lead aapke panel mein Leads mein bhi hai.',
  ].join('\n');
}

const STATUSES = ['new', 'assigned', 'closed'];

function clean(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * POST /api/v1/public/sell-property
 * Body: { name, phone, email?, property_type?, city?, locality?, address?,
 *         expected_price?, size_text?, description? }
 */
async function submitSellerLead(req, res) {
  const knex = req.app.get('db');
  const body = req.body || {};

  const name = clean(body.name, 255);
  const phone = normalizePhone(clean(body.phone, 20));
  if (!name || !phone || phone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Your name and a valid phone number are required.' }
    });
  }
  const email = clean(body.email, 255);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email.' } });
  }

  try {
    // Dedupe double-submits: same phone with a still-unassigned lead in the last day.
    const dup = await knex('seller_leads')
      .where({ phone, status: 'new' })
      .where('created_at', '>=', knex.raw("NOW() - INTERVAL '1 day'"))
      .first('id');
    if (dup) {
      return res.status(200).json({ success: true, message: 'We already have your request. Our team will contact you shortly.' });
    }

    await knex('seller_leads').insert({
      name,
      phone,
      email,
      property_type: clean(body.property_type, 50),
      city: clean(body.city, 100),
      locality: clean(body.locality, 255),
      address: clean(body.address, 1000),
      expected_price: clean(body.expected_price, 100),
      size_text: clean(body.size_text, 100),
      description: clean(body.description, 2000),
    });

    return res.status(201).json({
      success: true,
      message: 'Thanks! Our team will contact you shortly about selling your property.'
    });
  } catch (error) {
    console.error('Failed to submit seller lead:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to submit your request.' } });
  }
}

/**
 * GET /api/v1/admin/seller-leads?status=new|assigned|closed&limit&offset
 */
async function listSellerLeadsAdmin(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const { status } = req.query;

  try {
    let q = knex('seller_leads as s')
      .leftJoin('tenants as t', 's.assigned_tenant_id', 't.id')
      .select('s.*', 't.business_name as assigned_tenant_name')
      .orderBy('s.created_at', 'desc')
      .limit(limit)
      .offset(offset);
    if (status) {
      if (!STATUSES.includes(String(status))) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `status must be one of ${STATUSES.join(', ')}.` } });
      }
      q = q.where('s.status', String(status));
    }

    const [leads, counts] = await Promise.all([
      q,
      knex('seller_leads').groupBy('status').select('status').count('id as count'),
    ]);
    const byStatus = {};
    for (const r of counts) byStatus[r.status] = Number(r.count);

    return res.json({ success: true, byStatus, leads });
  } catch (error) {
    console.error('Failed to list seller leads:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list seller leads.' } });
  }
}

/**
 * PATCH /api/v1/admin/seller-leads/:id/assign
 * Body: { tenant_id, admin_notes? } — forwards the lead to a dealer. Also
 * works to re-assign; the previous dealer's lead row is left as-is.
 */
async function assignSellerLead(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const { tenant_id, admin_notes } = req.body || {};

  if (!tenant_id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'tenant_id is required.' } });
  }

  try {
    const lead = await knex('seller_leads').where({ id }).first();
    if (!lead) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Seller lead not found.' } });

    const tenant = await knex('tenants').where({ id: tenant_id }).first('id', 'status', 'business_name');
    if (!tenant) return res.status(404).json({ error: { code: 'TENANT_NOT_FOUND', message: 'Dealer not found.' } });
    if (tenant.status !== 'active') {
      return res.status(409).json({ error: { code: 'TENANT_INACTIVE', message: 'That dealer is not active.' } });
    }
    // Leads stay with Plotraa for a dealer whose trial ended / payment is due.
    if (!(await dealerIsActive(knex, tenant_id))) {
      return res.status(409).json({ error: { code: 'DEALER_UNPAID', message: 'This dealer\'s free trial has ended or a payment is pending. Keep the lead or pick another dealer.' } });
    }

    const [dealerLead] = await knex('leads')
      .insert({
        tenant_id,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        source: 'seller_lead',
        status: 'new',
        details: sellerLeadDetails(lead),
      })
      .returning(['id']);

    await knex('seller_leads').where({ id }).update({
      status: 'assigned',
      assigned_tenant_id: tenant_id,
      assigned_lead_id: dealerLead.id,
      assigned_at: knex.fn.now(),
      assigned_by: req.user.id || null,
      admin_notes: admin_notes !== undefined ? clean(admin_notes, 2000) : lead.admin_notes,
      updated_at: knex.fn.now(),
    });

    // Tell the dealer right away (best-effort; the lead is in their panel either way).
    let notified = false;
    try {
      const owner = await knex('users').where({ tenant_id, role: 'owner' }).whereNotNull('phone')
        .orderBy('created_at', 'asc').first('phone');
      if (owner?.phone) {
        await enqueueWhatsapp({ tenantId: tenant_id, phone: owner.phone, messageBody: buildDealerLeadAlert(lead, { dealerName: tenant.business_name }) });
        notified = true;
      }
    } catch (err) {
      console.error('Dealer lead alert failed (non-fatal):', err.message);
    }

    return res.json({ success: true, assigned_to: { id: tenant_id, business_name: tenant.business_name }, notified });
  } catch (error) {
    console.error('Failed to assign seller lead:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to assign seller lead.' } });
  }
}

/**
 * PATCH /api/v1/admin/seller-leads/:id
 * Body: { status?: 'new'|'closed', admin_notes? }
 */
async function updateSellerLead(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const { status, admin_notes } = req.body || {};
  const patch = {};

  if (status !== undefined) {
    if (!['new', 'closed'].includes(status)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "status must be 'new' or 'closed' (use /assign to assign)." } });
    }
    patch.status = status;
  }
  if (admin_notes !== undefined) patch.admin_notes = clean(admin_notes, 2000);
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Nothing to update.' } });
  }

  try {
    const n = await knex('seller_leads').where({ id }).update({ ...patch, updated_at: knex.fn.now() });
    if (!n) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Seller lead not found.' } });
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update seller lead:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update seller lead.' } });
  }
}

module.exports = {
  sellerLeadDetails,
  buildDealerLeadAlert, submitSellerLead, listSellerLeadsAdmin, assignSellerLead, updateSellerLead };
