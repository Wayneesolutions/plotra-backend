const { sendSetPasswordEmail } = require('../services/emailService');
const { normalizePhone } = require('../utils/phone');
const {
  placeholderEmail, unusablePasswordHash, createSetPasswordLink, buildSubDealerWelcomeMessage,
} = require('../services/dealerOnboardingService');

const { buildTemplate } = require('../services/whatsappTemplates');

const enqueueWhatsapp = (...a) => require('../services/agentMessagingService').enqueueAgentWhatsappSend(...a);

/**
 * POST /api/v1/dashboard/users/invite
 * Body: { name, phone?, email? } — at least one of phone/email.
 *
 * A dealer adds a SUB-DEALER (role 'agent' in the dealer's own space). No
 * password is created or shown to anyone: the sub-dealer gets a one-time
 * set-password link on WhatsApp (phone) or by email, and logs in with that
 * phone or email. With a phone they can also send listings on WhatsApp
 * straight away.
 */
async function inviteTenantUser(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase() || null;
  const phone = req.body?.phone ? normalizePhone(req.body.phone) : null;

  if (role !== 'owner') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only the dealer can add sub-dealers.' }
    });
  }

  if (!name || (!email && !phone)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Name and a phone number or email are required.' }
    });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email.' } });
  }

  try {
    if (email && await knex('users').where({ email }).first('id')) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_ENTRY', message: 'A user with this email already exists.' }
      });
    }
    if (phone && await knex('users').where({ phone }).first('id')) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_ENTRY', message: 'This phone number is already registered to another account.' }
      });
    }

    const [newUser] = await knex('users').insert({
      tenant_id,
      email: email || placeholderEmail(phone, 'subdealer'),
      name,
      role: 'agent',
      password_hash: await unusablePasswordHash(),
      phone,
    }).returning(['id', 'name', 'email', 'role', 'phone']);

    const setupUrl = await createSetPasswordLink(knex, newUser.id);
    const tenant = await knex('tenants').where({ id: tenant_id }).first('business_name');

    let sentVia = null;
    if (phone) {
      try {
        await enqueueWhatsapp({
          tenantId: tenant_id,
          phone,
          messageBody: buildSubDealerWelcomeMessage({ name, dealerName: tenant?.business_name || 'Aapke dealer', phone, setupUrl }),
          template: buildTemplate('subdealer_invite', {
            name, dealer_name: tenant?.business_name || 'Your dealer', login_id: phone, set_password_link: setupUrl,
          }),
        });
        sentVia = 'whatsapp';
      } catch (err) {
        console.error('Sub-dealer WhatsApp welcome failed (non-fatal):', err.message);
      }
    }
    if (email) {
      sendSetPasswordEmail({ to: email, setupUrl, name, dealerName: tenant?.business_name }).catch(() => {});
      sentVia = sentVia ? 'whatsapp_and_email' : 'email';
    }

    return res.status(201).json({
      success: true,
      message: sentVia
        ? 'Sub-dealer added. A set-password link was sent to them.'
        : 'Sub-dealer added. Share the set-password link with them.',
      user: { ...newUser, email: email || null },
      sentVia,
      // Fallback for the dealer to share by hand if delivery fails. One-time link, not a password.
      setupUrl,
    });

  } catch (error) {
    if (error.code === '23505') { // unique_violation — phone already registered to someone else
      return res.status(409).json({
        error: { code: 'DUPLICATE_ENTRY', message: 'This phone number is already registered to another account.' }
      });
    }
    console.error('Failed to invite tenant user:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create the user.' }
    });
  }
}

/**
 * GET /api/v1/dashboard/users
 * Lists this tenant's team members — powers the "assign to" dropdown for
 * per-listing WhatsApp attribution (listingController.js) as well as any
 * general team-management view. Includes users with no phone set too
 * (the frontend should just make clear those can't be assigned yet).
 */
async function listTenantUsers(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role, id: userId } = req.user;

  try {
    let query = knex('users')
      .where({ tenant_id })
      .select('id', 'name', 'email', 'phone', 'role')
      .orderBy('name', 'asc');

    // Privacy fix: an agent-role user previously got every team member's
    // name/email/phone back (it fed the per-listing "WhatsApp contact for
    // buyers" dropdown). Agents can't reassign listings anyway (see
    // listingController.updateListing), so they only ever need their own row.
    if (role === 'agent') {
      query = query.where({ id: userId });
    }

    const users = await query;

    return res.status(200).json({ success: true, users });
  } catch (error) {
    console.error('Failed to list tenant users:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load team members.' }
    });
  }
}

/**
 * PATCH /api/v1/dashboard/users/:id
 * Lets the owner add/change a team member's phone after creation — until
 * now the only way to set users.phone was at invite time
 * (inviteTenantUser above), so a mistyped or missing number was stuck
 * forever. Scoped to `phone` only; deliberately not a general user-edit
 * endpoint (name/email/role changes aren't asked for here).
 */
async function updateTenantUser(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const { id } = req.params;
  const { phone } = req.body;

  if (role !== 'owner') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only tenant owners can edit team members.' }
    });
  }

  if (phone === undefined) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Phone is required.' }
    });
  }

  try {
    const targetUser = await knex('users').where({ id, tenant_id }).first();
    if (!targetUser) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Team member not found.' }
      });
    }

    const [updatedUser] = await knex('users')
      .where({ id, tenant_id })
      .update({ phone: phone ? normalizePhone(phone) : null })
      .returning(['id', 'name', 'email', 'phone', 'role']);

    return res.status(200).json({ success: true, user: updatedUser });
  } catch (error) {
    if (error.code === '23505') { // unique_violation — phone already registered to someone else
      return res.status(409).json({
        error: { code: 'DUPLICATE_ENTRY', message: 'This phone number is already registered to another account.' }
      });
    }
    console.error('Failed to update tenant user:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update the team member.' }
    });
  }
}

module.exports = { inviteTenantUser, listTenantUsers, updateTenantUser };
