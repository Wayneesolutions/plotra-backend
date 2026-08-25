/**
 * Part 2, build-order item 4 — multiple WhatsApp numbers per tenant.
 *
 * Today a tenant has exactly one number (tenants.whatsapp_number +
 * tenants.phone_number_id, added in earlier migrations). The new tier
 * system needs up to 3 (Tier 2) or 5 (Tier 3) — a real multi-agency
 * dealer wants a front-desk number plus a couple of individual agents'
 * own numbers, each independently routable.
 *
 * tenants.whatsapp_number/phone_number_id are NOT dropped here — kept as
 * the tenant's default/primary number for backward compatibility with
 * any code that still reads them directly (e.g. tenant settings display),
 * and because dropping a column a live system depends on inside the same
 * PR that introduces its replacement is exactly how you get a bad
 * deploy. webhookController.js's inbound routing is repointed at this new
 * table in this same PR, though — that's the one place that actually
 * needs to know about every number, not just the default.
 *
 * Backfill: every currently-active tenant with an existing number gets
 * exactly one row here (is_default = true), so nothing about inbound
 * routing changes for a single-number tenant the moment this migration
 * runs — they're functionally on this table now too, just with one row.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('tenant_whatsapp_numbers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('phone_number_id', 100).nullable().unique(); // Meta Cloud API id — null for a BSP that doesn't use this concept
    table.string('whatsapp_number', 20).notNullable(); // E.164, digits only after '+'
    table.string('label', 100).nullable(); // e.g. "Front desk", "Agent Raj" — optional, display only
    table.boolean('is_default').notNullable().defaultTo(false);
    table.timestamps(true, true);

    table.unique(['tenant_id', 'whatsapp_number']);
    table.index(['whatsapp_number'], 'idx_tenant_wa_numbers_number');
  });

  // Exactly one default per tenant — enforced at the DB level, not just in
  // application code, since inbound routing and the dashboard UI both
  // assume there's a single unambiguous "default" to fall back to.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_tenant_wa_numbers_one_default
      ON tenant_whatsapp_numbers (tenant_id)
      WHERE is_default = true
  `);

  await knex.raw(`
    INSERT INTO tenant_whatsapp_numbers (tenant_id, phone_number_id, whatsapp_number, label, is_default)
    SELECT id, phone_number_id, whatsapp_number, 'Default', true
    FROM tenants
    WHERE whatsapp_number IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('tenant_whatsapp_numbers');
};
