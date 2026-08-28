const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendOnboardingEmail } = require('../services/emailService');
const { normalizePhone } = require('../utils/phone');

async function inviteTenantUser(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const { email, name, phone } = req.body;

  if (role !== 'owner') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only tenant owners can invite team members.' }
    });
  }

  if (!email || !name) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Email and name are required.' }
    });
  }

  try {
    const existingUser = await knex('users').where({ email: email.trim().toLowerCase() }).first();
    if (existingUser) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_ENTRY', message: 'A user with this email already exists.' }
      });
    }

    const tempPassword = `Welcome${crypto.randomBytes(4).toString('hex')}!`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const [newUser] = await knex('users').insert({
      tenant_id,
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role: 'agent',
      password_hash: hashedPassword,
      // Optional — lets this teammate text listing details into WhatsApp
      // right away (see webhookController.js's agent-intake routing)
      // instead of having to set it themselves after logging in.
      phone: phone ? normalizePhone(phone) : null
    }).returning(['id', 'email', 'role', 'phone']);

    const tenant = await knex('tenants').where({ id: tenant_id }).select('business_name').first();
    sendOnboardingEmail({
      to: email.trim().toLowerCase(),
      businessName: tenant?.business_name || '',
      contactName: name.trim(),
      email: email.trim().toLowerCase(),
      tempPassword,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: 'User created. An email with login credentials has been sent to them.',
      user: newUser,
      temporaryPassword: tempPassword
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
  const { tenant_id } = req.user;

  try {
    const users = await knex('users')
      .where({ tenant_id })
      .select('id', 'name', 'email', 'phone', 'role')
      .orderBy('name', 'asc');

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
