/**
 * Adds listings.has_house_number — set by the same GPT extraction call
 * that already parses raw_address/building_name/etc (listingExtractionService.js),
 * not a separate lookup. Used by geoEnrichmentWorker.js to route a listing
 * to the geocoding path actually suited to it: Address Validation API is
 * built for structured addresses with a house/plot number and has no
 * geographic bias parameter, so it caps at ROUTE granularity for a named
 * place with no number (a mall, a hotel) regardless of how findable that
 * place actually is — confirmed live in production. The legacy
 * Geocoding+Places path (with its Places "Find Place from Text" fallback)
 * is the one built to resolve a named place well.
 *
 * Nullable and left null for anything that doesn't go through GPT
 * extraction (dashboard-created listings) — geoEnrichmentWorker.js treats
 * null as "unknown" and keeps today's behavior (whatever
 * USE_ADDRESS_VALIDATION_API says), not a forced path either way.
 */
exports.up = function up(knex) {
  return knex.schema.alterTable('listings', (t) => {
    t.boolean('has_house_number').nullable();
  });
};

exports.down = function down(knex) {
  return knex.schema.alterTable('listings', (t) => {
    t.dropColumn('has_house_number');
  });
};
