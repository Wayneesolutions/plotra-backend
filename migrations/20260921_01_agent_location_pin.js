/**
 * WhatsApp location-pin geo-verification (PR 1).
 *
 * Adds a second, independent signal for listing coordinates: the agent's
 * own WhatsApp location share, alongside whatever Google's Geocoding /
 * Address Validation API already resolved. Existing lat/lng columns stay
 * the "current best" coordinate (whichever source is authoritative gets
 * written there via applyResolvedLocation, same as every other location
 * update path in this codebase); the new columns are purely additive audit
 * trail — nothing existing reads or depends on them.
 *
 * - location_source: 'geocode' (default, unchanged behavior for every
 *   existing row) | 'agent_pin' — which source lat/lng currently reflects.
 * - agent_pin_lat/lng: the raw coordinate the agent's WhatsApp location
 *   message carried, kept even when the geocoded value stays authoritative
 *   (large-drift case) — never overwritten, so a human reviewing later
 *   sees both numbers instead of just whichever one won.
 * - pin_geocode_distance_m: haversine distance between the two, computed
 *   once at pin-received time. Nullable — most listings never receive a
 *   pin at all.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.string('location_source', 20).notNullable().defaultTo('geocode');
    table.decimal('agent_pin_lat', 10, 7).nullable();
    table.decimal('agent_pin_lng', 10, 7).nullable();
    table.integer('pin_geocode_distance_m').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('location_source');
    table.dropColumn('agent_pin_lat');
    table.dropColumn('agent_pin_lng');
    table.dropColumn('pin_geocode_distance_m');
  });
};
