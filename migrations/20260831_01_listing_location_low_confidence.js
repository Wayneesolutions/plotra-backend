/**
 * Fixes a real accuracy gap: geoEnrichmentWorker.js always accepted
 * Google's first geocode result unconditionally, even when Google's own
 * response says it isn't a confident match (location_type of
 * GEOMETRIC_CENTER/APPROXIMATE, or partial_match:true) — nothing surfaced
 * this anywhere, so a listing could end up a kilometer or two off with no
 * one aware anything was uncertain. The typed address itself might be
 * exactly right; it's Google's structured-address parser that couldn't
 * resolve it to house-level precision, unlike the Google Maps app's own
 * search box (Places-style fuzzy matching), which is why the same address
 * finds the exact house there.
 *
 * geoEnrichmentWorker.js now also tries a Places text-search fallback
 * before giving up, and only sets this true when NEITHER approach found a
 * confident match — used by agentIntakeWorker.js's WhatsApp preview
 * message to explicitly tell the dealer to check/drag the pin rather than
 * approve on faith. Cleared (set back to false) whenever the location is
 * re-resolved from a corrected address, or a dealer manually drags the
 * pin (publicListingController.js's updateListingLocation) — a
 * human-placed pin is definitionally no longer "low confidence".
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.boolean('location_low_confidence').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('location_low_confidence');
  });
};
