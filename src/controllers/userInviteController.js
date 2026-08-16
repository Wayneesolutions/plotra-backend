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

module.exports = { inviteTenantUser };
