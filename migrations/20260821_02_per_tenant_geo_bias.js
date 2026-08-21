/**
 * Adds a per-tenant geocoding bias region to tenant_configs, replacing a
 * hardcoded Punjab/tricity bounding box in geoEnrichmentWorker.js
 * (introduced same-day to fix a wrong-city geocode — see commit cfc5d39).
 *
 * That fix works for the business today (100% Punjab dealers), but a
 * single hardcoded region baked into the code doesn't scale — the moment
 * there's a tenant operating in, say, Mumbai, the same Punjab bias would
 * quietly tilt THEIR ambiguous addresses in the wrong direction too. This
 * makes the bias a per-tenant config value instead: each agency's listings
 * get biased toward wherever THEY actually operate, set once per tenant,
 * no code change needed to onboard a tenant in a new city/state.
 *
 * Nullable by design — a tenant with no bias configured gets no
 * geographic bias at all (just the existing components=country:IN
 * national filter), rather than silently inheriting someone else's region.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('tenant_configs', (table) => {
    // Google's Geocoding API bounds format: "south,west|north,east"
    // (e.g. "29.30,73.80|32.55,76.95" for Punjab + tricity). Stored as a
    // single string in the exact format the API call needs, rather than
    // four separate numeric columns, since it's never queried/filtered
    // on — only ever read whole and passed straight into the geocode URL.
    table.string('geo_bias_bounds', 100).nullable();
  });

  // Preserve today's fix for existing tenants — same Punjab + tricity
  // bounds that were hardcoded, now living in config instead of code.
  await knex('tenant_configs').update({
    geo_bias_bounds: '29.30,73.80|32.55,76.95',
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('tenant_configs', (table) => {
    table.dropColumn('geo_bias_bounds');
  });
};
