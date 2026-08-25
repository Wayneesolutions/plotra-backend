// src/services/tenantWhatsappNumberService.js
//
// Manages tenant_whatsapp_numbers rows (see 20260825_02 migration) — the
// multi-number model that replaces "a tenant has exactly one number"
// (tenants.whatsapp_number/phone_number_id, which stay in place as the
// legacy default and are not read by any of this).

const { normalizePhone } = require('../utils/phone');

class WhatsappNumberLimitError extends Error {
  constructor(message, plan) {
    super(message);
    this.name = 'WhatsappNumberLimitError';
    this.plan = plan;
  }
}

async function listNumbers(knex, tenantId) {
  return knex('tenant_whatsapp_numbers')
    .where({ tenant_id: tenantId })
    .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'created_at', order: 'asc' }]);
}

/**
 * Adds a number, enforcing the tenant's plan cap (plans.max_whatsapp_numbers
 * — see 20260825_01_plan_tier_gates.js). The very first number a tenant
 * ever adds becomes the default automatically; every one after that is
 * additive until setDefault() is called explicitly.
 */
async function addNumber(knex, { tenantId, whatsappNumber, phoneNumberId = null, label = null }) {
  const normalized = normalizePhone(whatsappNumber);
  if (!normalized) {
    const err = new Error('whatsappNumber must be a valid phone number.');
    err.name = 'ValidationError';
    throw err;
  }

  const tenant = await knex('tenants').where({ id: tenantId }).first();
  const plan = await knex('plans').where({ key: tenant.plan }).first();
  const maxNumbers = plan?.max_whatsapp_numbers ?? 1;

  const { count } = await knex('tenant_whatsapp_numbers').where({ tenant_id: tenantId }).count('id as count').first();
  if (parseInt(count, 10) >= maxNumbers) {
    throw new WhatsappNumberLimitError(
      `Your ${plan?.label || 'current'} plan allows up to ${maxNumbers} WhatsApp number${maxNumbers === 1 ? '' : 's'}. Upgrade your plan to add more.`,
      plan
    );
  }

  const isFirstNumber = parseInt(count, 10) === 0;

  const [row] = await knex('tenant_whatsapp_numbers')
    .insert({
      tenant_id: tenantId,
      whatsapp_number: normalized,
      phone_number_id: phoneNumberId || null,
      label: label ? label.trim() : null,
      is_default: isFirstNumber,
    })
    .returning('*');

  return row;
}

/**
 * Removing the default number auto-promotes the tenant's oldest
 * remaining number to default (if any are left) — a tenant should never
 * be left with zero routable numbers while one still technically exists.
 */
async function removeNumber(knex, { tenantId, numberId }) {
  return knex.transaction(async (trx) => {
    const row = await trx('tenant_whatsapp_numbers').where({ id: numberId, tenant_id: tenantId }).first();
    if (!row) {
      const err = new Error('WhatsApp number not found on this account.');
      err.name = 'NotFoundError';
      throw err;
    }

    await trx('tenant_whatsapp_numbers').where({ id: numberId }).del();

    if (row.is_default) {
      const next = await trx('tenant_whatsapp_numbers')
        .where({ tenant_id: tenantId })
        .orderBy('created_at', 'asc')
        .first();
      if (next) {
        await trx('tenant_whatsapp_numbers').where({ id: next.id }).update({ is_default: true, updated_at: trx.fn.now() });
      }
    }

    return { removed: row.id };
  });
}

async function setDefault(knex, { tenantId, numberId }) {
  return knex.transaction(async (trx) => {
    const row = await trx('tenant_whatsapp_numbers').where({ id: numberId, tenant_id: tenantId }).first();
    if (!row) {
      const err = new Error('WhatsApp number not found on this account.');
      err.name = 'NotFoundError';
      throw err;
    }

    // Clear the old default first — the partial unique index (one default
    // per tenant) would otherwise reject the new row's UPDATE for briefly
    // having two defaults at once inside the same transaction.
    await trx('tenant_whatsapp_numbers').where({ tenant_id: tenantId, is_default: true }).update({ is_default: false, updated_at: trx.fn.now() });
    await trx('tenant_whatsapp_numbers').where({ id: numberId }).update({ is_default: true, updated_at: trx.fn.now() });

    return trx('tenant_whatsapp_numbers').where({ id: numberId }).first();
  });
}

/**
 * Inbound-routing lookup — webhookController.js's replacement for
 * querying tenants.phone_number_id/whatsapp_number directly. Tries
 * phone_number_id first (Meta Cloud API's stable, unambiguous id), then
 * falls back to the raw number (other BSPs) — same precedence the
 * original tenant-level lookup used.
 */
async function resolveTenantByReceivingNumber(knex, { phoneNumberId, whatsappNumber }) {
  if (phoneNumberId) {
    const row = await knex('tenant_whatsapp_numbers')
      .join('tenants', 'tenants.id', 'tenant_whatsapp_numbers.tenant_id')
      .where({ 'tenant_whatsapp_numbers.phone_number_id': phoneNumberId, 'tenants.status': 'active' })
      .select('tenants.*')
      .first();
    if (row) return row;
  }

  if (whatsappNumber) {
    const row = await knex('tenant_whatsapp_numbers')
      .join('tenants', 'tenants.id', 'tenant_whatsapp_numbers.tenant_id')
      .where({ 'tenant_whatsapp_numbers.whatsapp_number': whatsappNumber, 'tenants.status': 'active' })
      .select('tenants.*')
      .first();
    if (row) return row;
  }

  return null;
}

module.exports = {
  WhatsappNumberLimitError,
  listNumbers,
  addNumber,
  removeNumber,
  setDefault,
  resolveTenantByReceivingNumber,
};
