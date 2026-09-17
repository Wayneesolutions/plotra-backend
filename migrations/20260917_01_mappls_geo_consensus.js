/**
 * Adds Mappls (MapmyIndia) as a second, automatic geocoding provider
 * cross-validated against Google — see geoConsensusService.js and
 * mapplsGeocodingService.js. Google stays the source of truth for
 * area-level resolution; Mappls is only used to tighten the pin to
 * house/plot-number precision when it agrees with Google's neighbourhood.
 * No manual review step is introduced — the existing dealer/agent pin-drag
 * on the listing preview is unchanged.
 *
 * These columns are an audit trail, not used for anything user-facing
 * directly:
 *   - mappls_lat/mappls_lng: Mappls' own candidate coordinates, whether or
 *     not they ended up being used as the final listings.lat/lng.
 *   - geo_provider_agreement_meters: distance between Google's and
 *     Mappls' candidates for this listing. Null when Mappls wasn't called
 *     (feature disabled) or returned nothing (quota/network/no match).
 *   - geo_resolution_source: which provider's coordinates
 *     listings.lat/lng actually came from this resolution — 'google',
 *     'mappls_refined', or 'google_only_no_mappls' (Mappls unavailable).
 *     NULL for every listing resolved before this migration.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.decimal('mappls_lat', 10, 7).nullable();
    table.decimal('mappls_lng', 10, 7).nullable();
    table.integer('geo_provider_agreement_meters').nullable();
    table.text('geo_resolution_source').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('mappls_lat');
    table.dropColumn('mappls_lng');
    table.dropColumn('geo_provider_agreement_meters');
    table.dropColumn('geo_resolution_source');
  });
};
