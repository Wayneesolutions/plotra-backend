/**
 * Two related additions, both aimed at geocoding accuracy:
 *
 * 1. operating_city / operating_state on tenants (and tenant_requests, so
 *    the same info is captured at request time, before an admin approves
 *    it) — captured once per tenant at onboarding, used to auto-derive
 *    tenant_configs.geo_bias_bounds (see adminController.js's createTenant/
 *    approveRequest) instead of an admin having to hand-craft a bounds
 *    string. This is the "register every tenant with what area they deal
 *    in" piece.
 *
 * 2. pincode on listings — captured per-listing (optional, not required)
 *    from the dealer's own message when mentioned, or a follow-up. Indian
 *    PIN codes map to a small, precise area — far stronger disambiguation
 *    for a single listing than a tenant-wide city bias can ever be.
 *    geoEnrichmentWorker.js uses this as a strict postal_code component
 *    filter when present, falling back to the tenant's geo_bias_bounds
 *    when it isn't.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('tenants', (table) => {
    table.string('operating_city', 100).nullable();
    table.string('operating_state', 100).nullable();
  });

  await knex.schema.alterTable('tenant_requests', (table) => {
    table.string('operating_city', 100).nullable();
    table.string('operating_state', 100).nullable();
  });

  await knex.schema.alterTable('listings', (table) => {
    table.string('pincode', 10).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('pincode');
  });
  await knex.schema.alterTable('tenant_requests', (table) => {
    table.dropColumn('operating_city');
    table.dropColumn('operating_state');
  });
  await knex.schema.alterTable('tenants', (table) => {
    table.dropColumn('operating_city');
    table.dropColumn('operating_state');
  });
};
