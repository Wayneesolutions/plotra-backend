const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { JWT_SECRET } = require('../config/jwtSecret');
const { sendPasswordResetEmail } = require('../services/emailService');
const { normalizePhone } = require('../utils/phone');

const JWT_EXPIRES_IN = '12h'; // Optimal window for backoffice operational shift length
const RESET_TOKEN_TTL_MINUTES = 30;

/**
 * Handles agent/owner login and issues tenant-scoped authorization claims.
 */
async function login(req, res) {
  const knex = req.app.get('db'); // Reference to our migrated Knex client
  const { email, password } = req.body;

  // 1. Core input verification
  if (!email || !password) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Email and password are required fields.' }
    });
  }

  try {
    // 2. Locate user and eagerly join active tenant status profile
    const user = await knex('users')
      .join('tenants', 'users.tenant_id', 'tenants.id')
      .select(
        'users.id',
        'users.tenant_id',
        'users.name',
        'users.email',
        'users.password_hash',
        'users.role',
        'tenants.status as tenant_status',
        'tenants.business_name'
      )
      .where('users.email', email.trim().toLowerCase())
      .first();

    // 3. Fail gracefully if user doesn't exist (using vague errors to protect footprint discovery)
    if (!user) {
      return res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid authentication credentials.' }
      });
    }

    // 4. Validate system and tenant isolation health
    if (user.tenant_status !== 'active') {
      return res.status(403).json({
        error: { code: 'TENANT_LOCKED', message: 'Account context suspended or inactive. Please contact billing support.' }
      });
    }

    // 5. Verify cryptographically hashed password structure match
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid authentication credentials.' }
      });
    }

    // 6. Generate signed token container asserting immutable multi-tenant identity scope
    const token = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenant_id,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // 7. Dispatch success envelope containing application-ready details
    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        businessName: user.business_name
      }
    });

  } catch (error) {
    console.error('Login routing runtime failure:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Authentication handshake engine experienced a system crash.' }
    });
  }
}

/**
 * Lets an authenticated user change their own password. Verifies the
 * current password before applying the new one.
 */
async function changePassword(req, res) {
  const knex = req.app.get('db');
  const userId = req.user.id;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Current password and new password are both required.' }
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'New password must be at least 8 characters.' }
    });
  }

  try {
    const user = await knex('users').where({ id: userId }).first();
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) {
      return res.status(400).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' }
      });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await knex('users')
      .where({ id: userId })
      .update({ password_hash: newHash, updated_at: knex.fn.now() });

    return res.status(200).json({ success: true, message: 'Password updated.' });

  } catch (error) {
    console.error('Failed to change password:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update password.' }
    });
  }
}

/**
 * POST /api/v1/auth/update-phone
 * Lets an authenticated user set/change the WhatsApp number their agent
 * intake messages will be recognized from (see webhookController.js —
 * an inbound WhatsApp sender is treated as this agent only if their phone
 * matches this column). Globally unique across all tenants: a real phone
 * number only belongs to one person, and uniqueness is what lets the
 * webhook resolve both agent identity and tenant from the phone alone.
 */
async function updatePhone(req, res) {
  const knex = req.app.get('db');
  const userId = req.user.id;
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'phone is required.' } });
  }

  const normalized = normalizePhone(phone);

  try {
    await knex('users')
      .where({ id: userId })
      .update({ phone: normalized, updated_at: knex.fn.now() });

    return res.status(200).json({ success: true, phone: normalized });
  } catch (error) {
    if (error.code === '23505') { // unique_violation
      return res.status(409).json({
        error: { code: 'PHONE_ALREADY_REGISTERED', message: 'This phone number is already registered to another account.' }
      });
    }
    console.error('Failed to update phone:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update phone.' } });
  }
}

/**
 * POST /api/v1/auth/forgot-password
 * Public. Always returns a generic success message regardless of whether
 * the email matches an account — otherwise this endpoint becomes a way to
 * enumerate which emails have accounts. The reset email itself is only
 * sent if a match is found.
 */
async function forgotPassword(req, res) {
  const knex = req.app.get('db');
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Email is required.' } });
  }

  const genericResponse = {
    success: true,
    message: 'If an account exists for that email, a password reset link has been sent.',
  };

  try {
    // This is a legitimate cross-tenant lookup by email alone — a locked-out
    // user doesn't know their tenant_id, that's the whole point. Runs
    // outside any single tenant's RLS scope on purpose (this route has no
    // auth token yet by definition), same rationale as the service-context
    // routes: the real security control here is the emailed, single-use,
    // time-limited token, not tenant matching.
    await knex.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.is_service_context', 'true', true)");

      const user = await trx('users').where({ email: email.trim().toLowerCase() }).first();
      if (!user) return; // stay generic — don't reveal whether the email exists

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

      await trx('password_reset_tokens').insert({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
      });

      const resetUrl = `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}`;

      // Best-effort — never let an email failure change the generic response.
      sendPasswordResetEmail({ to: user.email, resetUrl }).catch((err) =>
        console.error('Password reset email failed (non-fatal):', err.message)
      );
    });

    return res.json(genericResponse);
  } catch (error) {
    console.error('forgotPassword error:', error.message);
    // Still return the generic message — don't leak whether something broke
    // vs. the email just not existing.
    return res.json(genericResponse);
  }
}

/**
 * POST /api/v1/auth/reset-password
 * Public. Consumes a token minted by forgotPassword.
 */
async function resetPassword(req, res) {
  const knex = req.app.get('db');
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'token and newPassword are required.' }
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'New password must be at least 8 characters.' }
    });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const result = await knex.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.is_service_context', 'true', true)");

      const resetRecord = await trx('password_reset_tokens')
        .where({ token_hash: tokenHash })
        .whereNull('used_at')
        .andWhere('expires_at', '>', trx.fn.now())
        .first();

      if (!resetRecord) {
        return { ok: false };
      }

      const newHash = await bcrypt.hash(newPassword, 10);

      await trx('users')
        .where({ id: resetRecord.user_id })
        .update({ password_hash: newHash, updated_at: trx.fn.now() });

      await trx('password_reset_tokens')
        .where({ id: resetRecord.id })
        .update({ used_at: trx.fn.now() });

      return { ok: true };
    });

    if (!result.ok) {
      return res.status(400).json({
        error: { code: 'INVALID_TOKEN', message: 'This reset link is invalid or has expired. Please request a new one.' }
      });
    }

    return res.json({ success: true, message: 'Password has been reset. You can now log in with your new password.' });
  } catch (error) {
    console.error('resetPassword error:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reset password.' } });
  }
}

module.exports = { login, changePassword, updatePhone, forgotPassword, resetPassword };
