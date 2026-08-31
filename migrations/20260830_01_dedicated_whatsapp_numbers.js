/**
 * Fixes a real gap found while investigating "Get full details on WhatsApp"
 * opening the shared 'Plotraa' number instead of a tenant's own dealer
 * number (Bug 5, Aug 30 handover): the dashboard's Settings.jsx already has
 * a full "buyer-facing WhatsApp number(s)" UI wired to
 * GET/POST/DELETE /api/v1/dashboard/whatsapp-numbers and
 * PATCH /api/v1/dashboard/whatsapp-numbers/:id/default, and
 * DashboardListings.jsx already reads billing.max_whatsapp_numbers to
 * decide whether to show the per-listing agent-assignment UI — but neither
 * plans.max_whatsapp_numbers nor a whatsapp_numbers table ever existed on
 * the backend. Every call 404'd (silently swallowed by the frontend's
 * .catch(() => {})), so no tenant had any way to ever set a buyer-facing
 * WhatsApp number themselves — tenants.whatsapp_number (migration
 * 20260701_01) stayed NULL forever, and the public listing pages fell back
 * to the shared platform number "working exactly as designed" but with no
 * way for a dealer to get out of that fallback.
 *
 * whatsapp_numbers supports more than one number per tenant (a Growth/
 * Unlimited tenant may want a couple of dedicated numbers to rotate
 * between team members — see the 20260821_04 per-listing attribution
 * migration this complements), with exactly one is_default per tenant
 * feeding the same dealer_whatsapp_number resolution
 * publicListingController.js already does for both the "full details" CTA
 * and the automated callback follow-up.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('plans', (table) => {
    // How many buyer-facing WhatsApp numbers a tenant on this plan may
    // register. Every plan gets at least 1 — connecting a dealer's own
    // number was never meant to be a paid-tier gate (see the phase3
    // migration this backs); only having MULTIPLE numbers to assign
    // per-listing (multi_agent_whatsapp) is the Growth/Unlimited feature.
    table.integer('max_whatsapp_numbers').notNullable().defaultTo(1);
  });

  await knex('plans').whereIn('key', ['growth', 'unlimited']).update({ max_whatsapp_numbers: 3 });
  await knex('plans').where({ key: 'unlimited' }).update({ max_whatsapp_numbers: 10 });

  await knex.schema.createTable('whatsapp_numbers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('whatsapp_number', 20).notNullable(); // E.164, matches tenants.whatsapp_number's format
    table.string('label', 100).nullable();
    table.boolean('is_default').notNullable().defaultTo(false);
    table.timestamps(true, true);
  });

  // One default per tenant — mirrors the "Make default" UI, which always
  // flips exactly one row on and clears the rest (see whatsappNumberController.js).
  await knex.raw(`
    CREATE UNIQUE INDEX whatsapp_numbers_one_default_per_tenant
    ON whatsapp_numbers (tenant_id)
    WHERE is_default = true
  `);

  // Backfill: a tenant that already has a legacy tenants.whatsapp_number
  // set gets it carried over as their first, default entry, so this
  // migration doesn't silently blank out a number that was already working.
  const existing = await knex('tenants').whereNotNull('whatsapp_number').select('id', 'whatsapp_number');
  for (const tenant of existing) {
    await knex('whatsapp_numbers').insert({
      tenant_id: tenant.id,
      whatsapp_number: tenant.whatsapp_number,
      label: 'Primary',
      is_default: true,
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('whatsapp_numbers');
  await knex.schema.alterTable('plans', (table) => {
    table.dropColumn('max_whatsapp_numbers');
  });
};
