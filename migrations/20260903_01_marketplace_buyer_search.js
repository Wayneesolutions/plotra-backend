/**
 * Marketplace buyer search (Phase 1 — search + tracking, no billing).
 *
 * A buyer messaging the shared platform WhatsApp number (not any dealer's
 * own registered number — see whatsapp_numbers / resolveTenantByReceivingNumber)
 * can now search across every tenant's active listings and get links back
 * without ever seeing an exact address. Two additive pieces:
 *
 * - listings.general_area: a locality-level area string ("Ferozepur Road,
 *   Ludhiana") derived from Google's address_components at geocode time —
 *   see geoEnrichmentWorker.js. Nullable and only populated going forward;
 *   existing listings stay NULL on purpose (frontend falls back to
 *   formatted_address for those — see PropertyView.jsx) so already-shared
 *   links don't change what they show.
 * - marketplace_lead_deliveries: one row per listing link actually sent to
 *   a buyer via this search flow. This is the ONLY source of "lead" counts
 *   for future per-lead billing (Phase 2) — a dealer sharing their own
 *   listing link never touches this table, so it can never be counted or
 *   charged as a marketplace-sourced lead.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.string('general_area', 255).nullable();
  });

  await knex.schema.createTable('marketplace_lead_deliveries', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('listing_id').notNullable().references('id').inTable('listings').onDelete('CASCADE');
    table.string('buyer_phone', 20).notNullable();
    table.text('matched_query').nullable(); // the buyer's raw search text, for later QA of match quality
    table.timestamp('delivered_at').notNullable().defaultTo(knex.fn.now());

    // Per-tenant lead counts (Phase 2 billing) is the primary read pattern.
    table.index(['tenant_id', 'delivered_at'], 'idx_marketplace_leads_tenant_date');
    table.index(['listing_id'], 'idx_marketplace_leads_listing');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('marketplace_lead_deliveries');
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('general_area');
  });
};
