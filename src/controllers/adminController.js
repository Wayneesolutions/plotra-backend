const bcrypt = require('bcryptjs');
const crypto = require('crypto');
// NEW — Phase 7
const { sendOnboardingEmail } = require('../services/emailService');

function generateTempPassword() {
  return `Welcome${crypto.randomBytes(4).toString('hex')}!`;
}

/**
 * POST /api/v1/public/request-access
 * Public — no auth. Saves a pending onboarding request from a prospective tenant.
 */
async function submitAccessRequest(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { business_name, contact_name, email, phone, message } = req.body;

  if (!business_name || !contact_name || !email || !phone) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Business name, contact name, email, and phone are required.' }
    });
  }

  try {
    const existing = await knex('tenant_requests')
      .where({ email: email.trim().toLowerCase(), status: 'pending' })
      .first();

    if (existing) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_REQUEST', message: 'A pending request from this email already exists.' }
      });
    }

    await knex('tenant_requests').insert({
      business_name: business_name.trim(),
      contact_name: contact_name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim(),
      message: message?.trim() || null,
    });

    return res.status(201).json({
      success: true,
      message: 'Your access request has been submitted. Our team will review and contact you shortly.'
    });
  } catch (error) {
    console.error('Failed to submit access request:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to submit request.' }
    });
  }
}

/**
 * GET /api/v1/admin/requests?status=pending
 * Lists all access requests, optionally filtered by status.
 */
async function listRequests(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { status } = req.query;

  try {
    let query = knex('tenant_requests').orderBy('created_at', 'desc');
    if (status) query = query.where({ status });

    const requests = await query;
    return res.json({ success: true, requests });
  } catch (error) {
    console.error('Failed to list requests:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch requests.' }
    });
  }
}

/**
 * POST /api/v1/admin/requests/:id/approve
 * Approves a pending request: creates tenant + owner user + tenant_config
 * in one transaction, then marks the request approved.
 * Returns the temporary password in the response — the same credentials
 * are also emailed to the new owner (NEW — Phase 7), so the response value
 * is now a fallback for display, not the only delivery channel.
 */
async function approveRequest(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const adminUserId = req.user.id;

  try {
    const request = await knex('tenant_requests').where({ id }).first();
    if (!request) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: `Request is already ${request.status}.` }
      });
    }

    const existingUser = await knex('users').where({ email: request.email }).first();
    if (existingUser) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_EMAIL', message: 'A user with this email already exists.' }
      });
    }

    const tempPassword = generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    let newTenant, newUser;

    await knex.transaction(async (trx) => {
      [newTenant] = await trx('tenants').insert({
        business_name: request.business_name,
        plan: 'starter',
        whatsapp_mode: 'shared',
        status: 'active',
      }).returning(['id', 'business_name', 'plan', 'status']);

      [newUser] = await trx('users').insert({
        tenant_id: newTenant.id,
        name: request.contact_name,
        email: request.email,
        password_hash: hashedPassword,
        role: 'owner',
      }).returning(['id', 'email', 'role']);

      await trx('tenant_configs').insert({
        tenant_id: newTenant.id,
        bsp_provider_type: 'shared_gateway',
        bsp_auth_token: null,
      });

      await trx('tenant_requests').where({ id }).update({
        status: 'approved',
        reviewed_by: adminUserId,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
    });

    // NEW — Phase 7: email the credentials. Best-effort; never blocks the
    // response, and the temp password is still returned below regardless.
    sendOnboardingEmail({
      to: newUser.email,
      businessName: newTenant.business_name,
      contactName: request.contact_name,
      email: newUser.email,
      tempPassword,
    }).catch((err) => console.error('Onboarding email failed (non-fatal):', err.message));

    return res.status(201).json({
      success: true,
      message: 'Request approved. Tenant account created.',
      tenant: newTenant,
      user: newUser,
      temporaryPassword: tempPassword,
    });
  } catch (error) {
    console.error('Failed to approve request:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to approve request.' }
    });
  }
}

/**
 * POST /api/v1/admin/requests/:id/reject
 */
async function rejectRequest(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const adminUserId = req.user.id;

  try {
    const request = await knex('tenant_requests').where({ id }).first();
    if (!request) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: `Request is already ${request.status}.` }
      });
    }

    await knex('tenant_requests').where({ id }).update({
      status: 'rejected',
      reviewed_by: adminUserId,
      reviewed_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });

    return res.json({ success: true, message: 'Request rejected.' });
  } catch (error) {
    console.error('Failed to reject request:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reject request.' }
    });
  }
}

/**
 * POST /api/v1/admin/tenants
 * Directly creates a new tenant without going through the request flow.
 * Also emails the credentials (NEW — Phase 7), same as approveRequest.
 */
async function createTenant(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { business_name, contact_name, email, phone } = req.body;

  if (!business_name || !contact_name || !email || !phone) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Business name, contact name, email, and phone are required.' }
    });
  }

  try {
    const existingUser = await knex('users').where({ email: email.trim().toLowerCase() }).first();
    if (existingUser) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_EMAIL', message: 'A user with this email already exists.' }
      });
    }

    const tempPassword = generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    let newTenant, newUser;

    await knex.transaction(async (trx) => {
      [newTenant] = await trx('tenants').insert({
        business_name: business_name.trim(),
        plan: 'starter',
        whatsapp_mode: 'shared',
        status: 'active',
      }).returning(['id', 'business_name', 'plan', 'status']);

      [newUser] = await trx('users').insert({
        tenant_id: newTenant.id,
        name: contact_name.trim(),
        email: email.trim().toLowerCase(),
        password_hash: hashedPassword,
        role: 'owner',
      }).returning(['id', 'email', 'role']);

      await trx('tenant_configs').insert({
        tenant_id: newTenant.id,
        bsp_provider_type: 'shared_gateway',
        bsp_auth_token: null,
      });
    });

    // NEW — Phase 7: email the credentials, best-effort.
    sendOnboardingEmail({
      to: newUser.email,
      businessName: newTenant.business_name,
      contactName: contact_name.trim(),
      email: newUser.email,
      tempPassword,
    }).catch((err) => console.error('Onboarding email failed (non-fatal):', err.message));

    return res.status(201).json({
      success: true,
      message: 'Tenant account created.',
      tenant: newTenant,
      user: newUser,
      temporaryPassword: tempPassword,
    });
  } catch (error) {
    console.error('Failed to create tenant:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create tenant.' }
    });
  }
}

/**
 * GET /api/v1/admin/tenants
 * Lists all tenants with their user counts.
 */
async function listTenants(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  try {
    const tenants = await knex('tenants')
      .select(
        'tenants.id',
        'tenants.business_name',
        'tenants.plan',
        'tenants.status',
        'tenants.subscription_status',
        'tenants.current_period_end',
        'tenants.created_at',
        knex.raw('count(users.id)::int as user_count')
      )
      .leftJoin('users', function () {
        // exclude the super_admin user from the count — they float above tenants
        this.on('tenants.id', '=', 'users.tenant_id')
            .andOnVal('users.role', '!=', 'super_admin');
      })
      .groupBy('tenants.id')
      .orderBy('tenants.created_at', 'desc');

    return res.json({ success: true, tenants });
  } catch (error) {
    console.error('Failed to list tenants:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch tenants.' }
    });
  }
}

/**
 * GET /api/v1/admin/tenants/:id
 * Fixes gap: clicking a tenant row in All Tenants rendered as plain text
 * with no detail view at all. Returns the tenant, its owner, its listings,
 * and a usage summary (views / leads / calculator uses) for this month.
 */
async function getTenantDetail(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;

  try {
    const tenant = await knex('tenants')
      .leftJoin('plans', 'tenants.plan', 'plans.key')
      .select(
        'tenants.id', 'tenants.business_name', 'tenants.plan', 'tenants.status',
        'tenants.whatsapp_mode', 'tenants.subscription_status', 'tenants.current_period_end',
        'tenants.created_at',
        'plans.label as plan_label', 'plans.price_inr as plan_price_inr'
      )
      .where('tenants.id', id)
      .first();

    if (!tenant) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tenant not found.' } });
    }

    const owner = await knex('users')
      .where({ tenant_id: id, role: 'owner' })
      .select('id', 'name', 'email')
      .first();

    const listings = await knex('listings')
      .leftJoin('listing_visits', 'listings.id', 'listing_visits.listing_id')
      .select(
        'listings.id', 'listings.title', 'listings.raw_address', 'listings.price', 'listings.status',
        knex.raw('COUNT(listing_visits.id)::int as visit_count')
      )
      .where('listings.tenant_id', id)
      .groupBy('listings.id')
      .orderBy('listings.created_at', 'desc');

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [{ count: viewCount }] = await knex('listing_visits')
      .join('listings', 'listing_visits.listing_id', 'listings.id')
      .where('listings.tenant_id', id)
      .andWhere('listing_visits.visited_at', '>=', startOfMonth)
      .count('listing_visits.id as count');

    const [{ count: leadCount }] = await knex('leads')
      .where({ tenant_id: id })
      .andWhere('created_at', '>=', startOfMonth)
      .count('id as count');

    const [{ count: calcCount }] = await knex('rent_vs_buy_calculations')
      .where({ tenant_id: id })
      .andWhere('created_at', '>=', startOfMonth)
      .count('id as count');

    return res.status(200).json({
      success: true,
      tenant: {
        id: tenant.id,
        businessName: tenant.business_name,
        plan: tenant.plan,
        planLabel: tenant.plan_label,
        planPriceINR: tenant.plan_price_inr,
        status: tenant.status,
        whatsappMode: tenant.whatsapp_mode,
        subscriptionStatus: tenant.subscription_status,
        currentPeriodEnd: tenant.current_period_end,
        createdAt: tenant.created_at,
      },
      owner: owner || null,
      listings,
      usageThisMonth: {
        views: parseInt(viewCount || 0),
        leadsCapture: parseInt(leadCount || 0),
        calculatorUses: parseInt(calcCount || 0),
      },
    });
  } catch (error) {
    console.error('Failed to fetch tenant detail:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch tenant detail.' }
    });
  }
}

/**
 * PATCH /api/v1/admin/tenants/:id/status
 * Suspend/reactivate a tenant. Suspending blocks every login for that
 * tenant (principal/agent) until reactivated — enforced in authController's
 * login check against tenants.status.
 */
async function updateTenantStatus(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const { status } = req.body || {};
  const ALLOWED = ['active', 'suspended', 'churned'];

  if (!ALLOWED.includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `status must be one of: ${ALLOWED.join(', ')}.` }
    });
  }

  try {
    const [updated] = await knex('tenants')
      .where({ id })
      .update({ status, updated_at: knex.fn.now() })
      .returning(['id', 'business_name', 'status']);

    if (!updated) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tenant not found.' } });
    }

    return res.status(200).json({ success: true, tenant: updated });
  } catch (error) {
    console.error('Failed to update tenant status:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update tenant status.' }
    });
  }
}

/**
 * PATCH /api/v1/admin/tenants/:id/plan
 * Admin-side manual plan override (e.g. a dealer paid offline, or support
 * is comping a plan change) — separate from the tenant's own self-serve
 * Stripe checkout in BillingModal.jsx.
 */
async function updateTenantPlan(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const { plan } = req.body || {};

  try {
    const planRow = await knex('plans').where({ key: plan, is_active: true }).first();
    if (!planRow) {
      const available = (await knex('plans').where({ is_active: true })).map((p) => p.key).join(', ');
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `plan must be one of: ${available}.` }
      });
    }

    const [updated] = await knex('tenants')
      .where({ id })
      .update({ plan, updated_at: knex.fn.now() })
      .returning(['id', 'business_name', 'plan']);

    if (!updated) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tenant not found.' } });
    }

    return res.status(200).json({ success: true, tenant: updated });
  } catch (error) {
    console.error('Failed to update tenant plan:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update tenant plan.' }
    });
  }
}

module.exports = {
  submitAccessRequest,
  listRequests,
  approveRequest,
  rejectRequest,
  createTenant,
  listTenants,
  getTenantDetail,
  updateTenantStatus,
  updateTenantPlan,
};
