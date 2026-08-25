const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
// NEW — Phase 7
const { sendOnboardingEmail } = require('../services/emailService');
const { resolveCityBounds } = require('../services/geoBiasService');
// Part 3 — WhatsApp self-serve onboarding
const { getPlan, createCheckoutSession } = require('../services/billingService');
const { addNumber } = require('../services/tenantWhatsappNumberService');
const { enqueueAgentWhatsappSend } = require('../services/agentMessagingService');

function generateTempPassword() {
  return `Welcome${crypto.randomBytes(4).toString('hex')}!`;
}

/**
 * POST /api/v1/public/request-access
 * Public — no auth. Saves a pending onboarding request from a prospective tenant.
 */
async function submitAccessRequest(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { business_name, contact_name, email, phone, message, operating_city, operating_state } = req.body;

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
      // Optional — which city/area this agency actually deals in. Used at
      // approval time to auto-derive their geocoding bias (see
      // geoBiasService.js) so their listings' addresses resolve accurately
      // without an admin having to configure that by hand.
      operating_city: operating_city?.trim() || null,
      operating_state: operating_state?.trim() || null,
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

    // WhatsApp-origin signups (Part 3) follow a different shape entirely —
    // no dashboard login (Tier 1 gets none, see the shape decided for that
    // tier), tenant created here but NOT activated until payment is
    // confirmed (confirmSignupPayment), and a WhatsApp reply instead of an
    // email as the notification channel. Branches out to its own function
    // rather than threading a dozen if(source==='whatsapp') checks through
    // the web-form logic below.
    if (request.source === 'whatsapp') {
      return approveWhatsappSignupRequest(req, res, knex, request, adminUserId);
    }

    const existingUser = await knex('users').where({ email: request.email }).first();
    if (existingUser) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_EMAIL', message: 'A user with this email already exists.' }
      });
    }

    const tempPassword = generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Resolved before opening the transaction — this is a real HTTP call
    // to Google, and a DB transaction shouldn't sit open for however long
    // that takes (or however long a retry/timeout takes if it's slow).
    const geoBiasBounds = await resolveCityBounds(request.operating_city, request.operating_state);

    let newTenant, newUser;

    await knex.transaction(async (trx) => {
      [newTenant] = await trx('tenants').insert({
        business_name: request.business_name,
        plan: 'starter',
        whatsapp_mode: 'shared',
        status: 'active',
        operating_city: request.operating_city,
        operating_state: request.operating_state,
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
        geo_bias_bounds: geoBiasBounds,
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
 * Approval path for a WhatsApp self-serve signup (request.source ===
 * 'whatsapp'). Creates the tenant now, but in status = 'pending_payment'
 * — NOT active, and with NO users row at all (Tier 1 has no dashboard
 * login by design; there is no owner to create). Sends the prospect a
 * Stripe Checkout link over WhatsApp as the payment step ("QR code" per
 * the brief — Stripe's own hosted Checkout page renders a UPI QR to an
 * Indian payer who selects UPI, without Plotra needing to generate and
 * send an image itself, which nothing in this codebase does today).
 * Actual activation (tenants.status -> 'active', wiring the requested
 * number into tenant_whatsapp_numbers) only happens in
 * confirmSignupPayment, once a human explicitly confirms payment — not
 * automatically from a Stripe webhook, matching the brief's "Once payment
 * is confirmed by super-admin" for both the QR and cash paths alike.
 */
async function approveWhatsappSignupRequest(req, res, knex, request, adminUserId) {
  try {
    const plan = await getPlan(knex, request.requested_plan);
    if (!plan) {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: `Requested plan "${request.requested_plan}" does not exist.` }
      });
    }

    let newTenant;
    await knex.transaction(async (trx) => {
      [newTenant] = await trx('tenants').insert({
        business_name: request.business_name,
        plan: plan.key,
        whatsapp_mode: 'dedicated',
        status: 'pending_payment',
      }).returning(['id', 'business_name', 'plan', 'status']);

      await trx('tenant_configs').insert({
        tenant_id: newTenant.id,
        bsp_provider_type: 'shared_gateway',
        bsp_auth_token: null,
        // No structured city/state was collected in the WhatsApp flow
        // (just a free-text area, stored in tenant_requests.message) —
        // resolveCityBounds needs both to look up real bounds, so this
        // is left unset rather than guessed. A super-admin can set it
        // later the same way any tenant_config gets edited.
        geo_bias_bounds: null,
      });

      await trx('tenant_requests').where({ id: request.id }).update({
        status: 'approved',
        reviewed_by: adminUserId,
        reviewed_at: trx.fn.now(),
        tenant_id: newTenant.id,
        updated_at: trx.fn.now(),
      });
    });

    const paymentEventId = uuidv4();
    const { sessionId, url } = await createCheckoutSession({
      plan: plan.key,
      planRow: plan,
      paymentEventId,
      userEmail: undefined, // none collected in this flow — Stripe Checkout will ask for one itself
      stripeCustomerId: null,
      successUrl: process.env.WHATSAPP_SIGNUP_PAYMENT_SUCCESS_URL || `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/`,
      cancelUrl: process.env.WHATSAPP_SIGNUP_PAYMENT_CANCEL_URL || `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/`,
    });

    await knex('payment_events').insert({
      id: paymentEventId,
      tenant_id: newTenant.id,
      stripe_session_id: sessionId,
      plan: plan.key,
      amount_paise: plan.price_inr * 100,
      status: 'created',
    });

    await knex('tenant_requests').where({ id: request.id }).update({ payment_status: 'qr_sent', updated_at: knex.fn.now() });
    await knex('whatsapp_signup_sessions').where({ tenant_request_id: request.id }).update({ state: 'awaiting_payment', updated_at: knex.fn.now() });

    await enqueueAgentWhatsappSend({
      tenantId: null,
      phone: request.phone,
      messageBody: `You're approved! 🎉 Complete payment (₹${plan.price_inr}/month) to activate your account:\n\n${url}\n\nAlready paid in cash? Just reply CASH.`,
    });

    return res.status(201).json({
      success: true,
      message: 'Request approved. Tenant created (pending payment) and payment link sent over WhatsApp.',
      tenant: newTenant,
      checkoutUrl: url,
    });
  } catch (error) {
    console.error('Failed to approve WhatsApp signup request:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve request.' } });
  }
}

/**
 * PATCH /api/v1/admin/requests/:id/confirm-payment
 * Body: { method: 'qr' | 'cash' }
 * The one required human sign-off before a WhatsApp signup's tenant
 * actually goes live — see approveWhatsappSignupRequest's header for why
 * this isn't automatic even for the Stripe-paid ("qr") path. Activates
 * the tenant and wires its requested number into tenant_whatsapp_numbers
 * as the default.
 */
async function confirmSignupPayment(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const { method } = req.body || {};
  const adminUserId = req.user.id;

  if (!['qr', 'cash'].includes(method)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "method must be 'qr' or 'cash'." } });
  }

  try {
    const request = await knex('tenant_requests').where({ id }).first();
    if (!request || request.source !== 'whatsapp') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'WhatsApp signup request not found.' } });
    }
    if (request.status !== 'approved' || !request.tenant_id) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Request must be approved (with a tenant created) before confirming payment.' } });
    }
    if (request.payment_status && request.payment_status.startsWith('paid_')) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Payment for this request has already been confirmed.' } });
    }

    let tenant;
    await knex.transaction(async (trx) => {
      [tenant] = await trx('tenants')
        .where({ id: request.tenant_id })
        .update({ status: 'active', updated_at: trx.fn.now() })
        .returning(['id', 'business_name', 'plan', 'status']);

      await trx('tenant_requests').where({ id }).update({
        payment_status: method === 'qr' ? 'paid_qr' : 'paid_cash',
        payment_confirmed_by: adminUserId,
        payment_confirmed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });

      await trx('whatsapp_signup_sessions').where({ tenant_request_id: id }).update({ state: 'completed', updated_at: trx.fn.now() });
    });

    // Enforces plans.max_whatsapp_numbers same as any other add — a Tier 1
    // plan allows exactly 1, so this is always the tenant's first and only
    // number, becoming the default automatically (see addNumber).
    await addNumber(knex, {
      tenantId: request.tenant_id,
      whatsappNumber: request.requested_whatsapp_number,
    });

    await enqueueAgentWhatsappSend({
      tenantId: null,
      phone: request.phone,
      messageBody: "Payment confirmed! 🎉 You're all set — text your property details here anytime to list them on Plotra.",
    });

    return res.json({ success: true, message: 'Payment confirmed. Tenant activated.', tenant });
  } catch (error) {
    console.error('Failed to confirm signup payment:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to confirm payment.' } });
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
  const { business_name, contact_name, email, phone, operating_city, operating_state } = req.body;

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

    // Same reasoning as approveRequest — resolved before the transaction
    // opens, since it's a real external HTTP call.
    const geoBiasBounds = await resolveCityBounds(operating_city, operating_state);

    let newTenant, newUser;

    await knex.transaction(async (trx) => {
      [newTenant] = await trx('tenants').insert({
        business_name: business_name.trim(),
        plan: 'starter',
        whatsapp_mode: 'shared',
        status: 'active',
        operating_city: operating_city?.trim() || null,
        operating_state: operating_state?.trim() || null,
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
        geo_bias_bounds: geoBiasBounds,
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
  confirmSignupPayment,
  rejectRequest,
  createTenant,
  listTenants,
  getTenantDetail,
  updateTenantStatus,
  updateTenantPlan,
};
