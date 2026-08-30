// src/controllers/whatsappNumberController.js
//
// Owner-facing CRUD for a tenant's buyer-facing WhatsApp number(s) — the
// number(s) the "Get full details on WhatsApp" CTA and the automated
// callback follow-up (publicListingController.js) resolve to, distinct
// from a user's own personal intake number (users.phone, authController.js's
// updatePhone). See migration 20260830_01_dedicated_whatsapp_numbers.js for
// why this table exists — Settings.jsx already had a full UI wired to these
// exact routes with no backend behind them.
const { normalizePhone } = require('../utils/phone');

function requireOwner(req, res) {
  if (req.user.role !== 'owner') {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only tenant owners can manage WhatsApp numbers.' }
    });
    return false;
  }
  return true;
}

/**
 * GET /api/v1/dashboard/whatsapp-numbers
 */
async function listWhatsappNumbers(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  if (!requireOwner(req, res)) return;

  try {
    const numbers = await knex('whatsapp_numbers')
      .select('id', 'whatsapp_number', 'label', 'is_default')
      .where({ tenant_id: req.user.tenant_id })
      .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'created_at', order: 'asc' }]);

    return res.status(200).json({ success: true, numbers });
  } catch (error) {
    console.error('Failed to list WhatsApp numbers:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load WhatsApp numbers.' } });
  }
}

/**
 * POST /api/v1/dashboard/whatsapp-numbers
 * body: { whatsappNumber, label? }
 * Capped by plans.max_whatsapp_numbers — every plan gets at least 1 (see
 * the migration), so this only actually blocks a Growth/Unlimited tenant
 * trying to add beyond their tier's number of dedicated lines.
 */
async function addWhatsappNumber(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  if (!requireOwner(req, res)) return;

  const { whatsappNumber, label } = req.body || {};
  if (!whatsappNumber || !whatsappNumber.trim()) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'whatsappNumber is required.' } });
  }

  const tenantId = req.user.tenant_id;
  const normalized = normalizePhone(whatsappNumber);

  try {
    const tenant = await knex('tenants')
      .leftJoin('plans', 'tenants.plan', 'plans.key')
      .select('plans.max_whatsapp_numbers')
      .where({ 'tenants.id': tenantId })
      .first();
    const maxNumbers = tenant?.max_whatsapp_numbers ?? 1;

    const currentCount = await knex('whatsapp_numbers').where({ tenant_id: tenantId }).count('id as count').first();
    if (Number(currentCount.count) >= maxNumbers) {
      return res.status(403).json({
        error: {
          code: 'PLAN_LIMIT_REACHED',
          message: `Your plan allows up to ${maxNumbers} WhatsApp number${maxNumbers === 1 ? '' : 's'}. Upgrade to add more.`
        }
      });
    }

    const isFirst = Number(currentCount.count) === 0;

    const [number] = await knex('whatsapp_numbers')
      .insert({
        tenant_id: tenantId,
        whatsapp_number: normalized,
        label: label ? label.trim() : null,
        is_default: isFirst, // first number for a tenant is automatically the default
      })
      .returning(['id', 'whatsapp_number', 'label', 'is_default']);

    // Keep the legacy tenants.whatsapp_number column (still read directly
    // by some older lookups — see webhookController.js's inbound routing)
    // in sync whenever the default changes.
    if (isFirst) {
      await knex('tenants').where({ id: tenantId }).update({ whatsapp_number: normalized, updated_at: knex.fn.now() });
    }

    return res.status(201).json({ success: true, number });
  } catch (error) {
    console.error('Failed to add WhatsApp number:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to add WhatsApp number.' } });
  }
}

/**
 * DELETE /api/v1/dashboard/whatsapp-numbers/:id
 * If the removed number was the default, promotes the next-oldest
 * remaining number (if any) so a tenant is never left with zero
 * default and buyer CTAs quietly falling back to the shared number
 * without anyone noticing.
 */
async function removeWhatsappNumber(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  if (!requireOwner(req, res)) return;

  const tenantId = req.user.tenant_id;
  const { id } = req.params;

  try {
    const number = await knex('whatsapp_numbers').where({ id, tenant_id: tenantId }).first();
    if (!number) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'WhatsApp number not found.' } });
    }

    await knex('whatsapp_numbers').where({ id, tenant_id: tenantId }).del();

    if (number.is_default) {
      const next = await knex('whatsapp_numbers')
        .where({ tenant_id: tenantId })
        .orderBy('created_at', 'asc')
        .first();

      await knex('tenants').where({ id: tenantId }).update({
        whatsapp_number: next ? next.whatsapp_number : null,
        updated_at: knex.fn.now(),
      });

      if (next) {
        await knex('whatsapp_numbers').where({ id: next.id }).update({ is_default: true });
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to remove WhatsApp number:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to remove WhatsApp number.' } });
  }
}

/**
 * PATCH /api/v1/dashboard/whatsapp-numbers/:id/default
 */
async function setDefaultWhatsappNumber(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  if (!requireOwner(req, res)) return;

  const tenantId = req.user.tenant_id;
  const { id } = req.params;

  try {
    const number = await knex('whatsapp_numbers').where({ id, tenant_id: tenantId }).first();
    if (!number) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'WhatsApp number not found.' } });
    }

    await knex.transaction(async (trx) => {
      await trx('whatsapp_numbers').where({ tenant_id: tenantId }).update({ is_default: false });
      await trx('whatsapp_numbers').where({ id }).update({ is_default: true });
      await trx('tenants').where({ id: tenantId }).update({ whatsapp_number: number.whatsapp_number, updated_at: trx.fn.now() });
    });

    return res.status(200).json({ success: true, number: { ...number, is_default: true } });
  } catch (error) {
    console.error('Failed to set default WhatsApp number:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to set default WhatsApp number.' } });
  }
}

module.exports = { listWhatsappNumbers, addWhatsappNumber, removeWhatsappNumber, setDefaultWhatsappNumber };
