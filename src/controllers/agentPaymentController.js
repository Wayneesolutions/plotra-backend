// src/controllers/agentPaymentController.js
//
// Agent payment/subscription system (PR 2): the WhatsApp-facing receipt
// intake (called from webhookController.js, same dispatch style as
// agentIntakeController.js) plus the super-admin review/management
// endpoints (mounted in src/routes/admin.js, same authGuard+adminGuard+
// serviceContext chain as every other admin route).
const { logAgentOutboundMessage, enqueueAgentWhatsappSend } = require('../services/agentMessagingService');
const { downloadWhatsAppMedia } = require('./agentIntakeController');
const { uploadToS3 } = require('../services/s3Service');

/**
 * Agent texted a payment-intent keyword ("payment"/"receipt"/"bhugtan" —
 * see agentPaymentService.js's RECEIPT_SUBMISSION_KEYWORDS). Arms the
 * awaiting_receipt_submission flag so the NEXT photo this agent sends is
 * captured as a receipt instead of falling into the normal property-photo
 * path (agentIntakeController.js's uploadAgentPhoto) — see
 * webhookController.js for the dispatch order that makes this work.
 */
async function handleAgentReceiptIntent({ knex, agentUser, res }) {
  try {
    await knex('users').where({ id: agentUser.id }).update({ awaiting_receipt_submission: true, updated_at: knex.fn.now() });
    const body = '📸 Please send a photo of your payment receipt now.';
    await enqueueAgentWhatsappSend({ tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: body });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to arm receipt-submission flag:', error.message);
    return res.status(200).json({ success: true, trackingError: error.message });
  }
}

/**
 * The photo that arrives while awaiting_receipt_submission is true —
 * uploads it under a distinct S3 prefix from property photos (audit/
 * organization only, doesn't change behavior), records a payment_submissions
 * row, and clears the flag regardless of outcome so a failed upload doesn't
 * leave the agent permanently stuck capturing every future photo as a
 * receipt.
 */
async function handleAgentReceiptPhoto({ knex, agentUser, mediaId, mediaMimeType, res }) {
  try {
    const buffer = await downloadWhatsAppMedia(mediaId);
    const extension = mediaMimeType?.includes('png') ? 'png' : mediaMimeType?.includes('webp') ? 'webp' : 'jpg';
    const url = await uploadToS3(buffer, `receipt-${mediaId}.${extension}`, mediaMimeType || 'image/jpeg', 'payment-receipts');

    await knex.transaction(async (trx) => {
      await trx('payment_submissions').insert({
        tenant_id: agentUser.tenant_id,
        agent_id: agentUser.id,
        receipt_photo_url: url,
      });
      await trx('users').where({ id: agentUser.id }).update({
        awaiting_receipt_submission: false,
        payment_status: 'pending_review',
        updated_at: trx.fn.now(),
      });
    });

    const body = '✅ Receipt received — an admin will review it shortly. Your existing listings and access stay as they are until then.';
    await enqueueAgentWhatsappSend({ tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: body });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to process agent receipt photo:', error.message);
    // Clear the flag even on failure — same rationale as the docstring
    // above, a stuck flag is worse than asking the agent to resend.
    await knex('users').where({ id: agentUser.id }).update({ awaiting_receipt_submission: false, updated_at: knex.fn.now() }).catch(() => {});
    return res.status(200).json({ success: true, trackingError: error.message });
  }
}

// ── Super-admin endpoints (mounted under /api/v1/admin, authGuard +
//    adminGuard + serviceContext already applied at the router level —
//    see src/routes/admin.js) ─────────────────────────────────────────

/**
 * @route GET /api/v1/admin/payment-submissions?status=pending
 */
async function listPaymentSubmissions(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { status } = req.query;
  try {
    let query = knex('payment_submissions as ps')
      .join('users as u', 'ps.agent_id', 'u.id')
      .join('tenants as t', 'ps.tenant_id', 't.id')
      .leftJoin('packages as pkg', 'u.package_id', 'pkg.id')
      .select(
        'ps.id', 'ps.receipt_photo_url', 'ps.amount_inr', 'ps.submitted_at', 'ps.status',
        'ps.reviewed_at', 'ps.reviewed_by',
        'u.id as agent_id', 'u.name as agent_name', 'u.phone as agent_phone',
        't.business_name as tenant_business_name',
        'pkg.name as package_name', 'pkg.amount_inr as package_amount_inr'
      )
      .orderBy('ps.submitted_at', 'desc');

    if (status) query = query.where('ps.status', status);

    const submissions = await query;
    return res.status(200).json({ success: true, submissions });
  } catch (error) {
    console.error('Failed to list payment submissions:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load payment submissions.' } });
  }
}

/**
 * @route PATCH /api/v1/admin/payment-submissions/:id/approve
 * Sets the submission approved, the agent's payment_status to 'paid',
 * re-enables can_add_listing (in case the reminder cron had already
 * flipped it off), and resets their cycle — see agentPaymentService.js's
 * getCycleAnchorDate, which reads reviewed_at back out for the next due
 * date, so this single write is the entire "reset the cycle" step.
 */
async function approvePaymentSubmission(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const adminUserId = req.user.id;
  try {
    const submission = await knex('payment_submissions').where({ id }).first();
    if (!submission) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Submission not found.' } });
    if (submission.status !== 'pending') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: `Submission is already ${submission.status}.` } });
    }

    await knex.transaction(async (trx) => {
      await trx('payment_submissions').where({ id }).update({
        status: 'approved', reviewed_by: adminUserId, reviewed_at: trx.fn.now(), updated_at: trx.fn.now(),
      });
      await trx('users').where({ id: submission.agent_id }).update({
        payment_status: 'paid', can_add_listing: true, updated_at: trx.fn.now(),
      });
    });

    const agent = await knex('users').where({ id: submission.agent_id }).first();
    if (agent) {
      await enqueueAgentWhatsappSend({
        tenantId: agent.tenant_id, phone: agent.phone,
        messageBody: '✅ Your payment has been approved. Thank you!',
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to approve payment submission:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve this submission.' } });
  }
}

/**
 * @route PATCH /api/v1/admin/payment-submissions/:id/reject
 * Deliberately does NOT touch payment_status/can_add_listing — a rejected
 * receipt (blurry photo, wrong amount) just means the agent needs to
 * resubmit; it isn't itself a reason to newly restrict them if they
 * weren't already restricted, and if they were, the restriction cron
 * already covers that independently.
 */
async function rejectPaymentSubmission(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const adminUserId = req.user.id;
  try {
    const submission = await knex('payment_submissions').where({ id }).first();
    if (!submission) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Submission not found.' } });
    if (submission.status !== 'pending') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: `Submission is already ${submission.status}.` } });
    }

    await knex('payment_submissions').where({ id }).update({
      status: 'rejected', reviewed_by: adminUserId, reviewed_at: knex.fn.now(), updated_at: knex.fn.now(),
    });

    const agent = await knex('users').where({ id: submission.agent_id }).first();
    if (agent) {
      await knex('users').where({ id: agent.id }).update({ payment_status: 'unpaid', updated_at: knex.fn.now() });
      await enqueueAgentWhatsappSend({
        tenantId: agent.tenant_id, phone: agent.phone,
        messageBody: "❌ We couldn't verify that receipt — please resend a clear photo of your payment (or reply \"payment\" to try again).",
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to reject payment submission:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject this submission.' } });
  }
}

/**
 * @route GET /api/v1/admin/agents-payments
 * Platform-wide agent list with payment/cycle status — backs the "All
 * agents" admin panel table (package, last payment date, next due date,
 * status). next_due_date is computed the same way the reminder cron does
 * (onboarded_at, or last approved payment's reviewed_at, + 1 month).
 */
async function listAgentsPaymentStatus(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  try {
    const agents = await knex('users as u')
      .where('u.role', 'agent')
      .leftJoin('packages as pkg', 'u.package_id', 'pkg.id')
      .leftJoin('tenants as t', 'u.tenant_id', 't.id')
      .select(
        'u.id', 'u.name', 'u.phone', 'u.onboarded_at', 'u.payment_status', 'u.can_add_listing',
        't.business_name as tenant_business_name',
        'pkg.name as package_name', 'pkg.amount_inr as package_amount_inr'
      )
      .orderBy('u.name', 'asc');

    const lastPayments = await knex('payment_submissions')
      .where({ status: 'approved' })
      .select('agent_id')
      .max('reviewed_at as last_payment_date')
      .groupBy('agent_id');
    const lastPaymentByAgent = new Map(lastPayments.map((r) => [r.agent_id, r.last_payment_date]));

    const enriched = agents.map((a) => {
      const lastPaymentDate = lastPaymentByAgent.get(a.id) || null;
      const anchor = new Date(lastPaymentDate || a.onboarded_at);
      const nextDueDate = new Date(anchor.getTime() + 30 * 24 * 60 * 60 * 1000);
      return { ...a, last_payment_date: lastPaymentDate, next_due_date: nextDueDate.toISOString() };
    });

    return res.status(200).json({ success: true, agents: enriched });
  } catch (error) {
    console.error('Failed to list agents payment status:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load agents.' } });
  }
}

/**
 * @route GET /api/v1/admin/packages
 */
async function listPackagesAdmin(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  try {
    const packages = await knex('packages').orderBy('sort_order', 'asc');
    return res.status(200).json({ success: true, packages });
  } catch (error) {
    console.error('Failed to list packages:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load packages.' } });
  }
}

/**
 * @route POST /api/v1/admin/packages
 * body: { name, amount_inr, qr_code_url?, sort_order? }
 * qr_code_url is a plain URL string — the QR image itself is uploaded
 * wherever the admin already hosts static assets; this endpoint doesn't
 * handle image upload (no admin-facing file-upload pattern exists
 * elsewhere in this codebase to match — every existing upload path is a
 * WhatsApp-media-to-S3 one, agent-initiated, not admin-initiated).
 */
async function createPackage(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { name, amount_inr, qr_code_url, sort_order } = req.body;
  if (!name || !Number.isFinite(Number(amount_inr))) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and amount_inr are required.' } });
  }
  try {
    const [pkg] = await knex('packages').insert({
      name, amount_inr: Number(amount_inr), qr_code_url: qr_code_url || null, sort_order: sort_order ?? 0,
    }).returning('*');
    return res.status(201).json({ success: true, package: pkg });
  } catch (error) {
    console.error('Failed to create package:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create package.' } });
  }
}

/**
 * @route PATCH /api/v1/admin/packages/:id
 */
async function updatePackage(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const { name, amount_inr, qr_code_url, is_active, sort_order } = req.body;
  const updates = { updated_at: knex.fn.now() };
  if (name !== undefined) updates.name = name;
  if (amount_inr !== undefined) updates.amount_inr = Number(amount_inr);
  if (qr_code_url !== undefined) updates.qr_code_url = qr_code_url;
  if (is_active !== undefined) updates.is_active = !!is_active;
  if (sort_order !== undefined) updates.sort_order = sort_order;

  try {
    const [pkg] = await knex('packages').where({ id }).update(updates).returning('*');
    if (!pkg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Package not found.' } });
    return res.status(200).json({ success: true, package: pkg });
  } catch (error) {
    console.error('Failed to update package:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update package.' } });
  }
}

module.exports = {
  handleAgentReceiptIntent,
  handleAgentReceiptPhoto,
  listPaymentSubmissions,
  approvePaymentSubmission,
  rejectPaymentSubmission,
  listAgentsPaymentStatus,
  listPackagesAdmin,
  createPackage,
  updatePackage,
};
