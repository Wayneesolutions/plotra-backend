/**
 * Location pin at listing time.
 *
 * WhatsApp intake now asks every agent for a live location / location pin
 * alongside the address (agentIntakeWorker.js), and accepts a pin at ANY
 * point in the conversation, including before the listing row exists
 * (agentIntakeController.js handleAgentLocationPin). Until now a pin sent
 * before the listing was created was rejected with "start a listing first".
 *
 * - pending_pin_lat/lng: a pin shared before the listing exists. Copied onto
 *   the new listing (agent_pin_lat/lng, location_source='agent_pin') by
 *   listingService.createListingRecord, where geoEnrichmentWorker.js treats
 *   it as the final coordinate instead of the geocode.
 * - location_pin_requested_at: when we asked for the pin. Used so the ask
 *   happens once per draft, and so geoEnrichmentWorker.js doesn't send a
 *   second "please share a pin" message after the agent already said they
 *   can't.
 *
 * Additive only; `down` reverses it.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.decimal('pending_pin_lat', 10, 7).nullable();
    table.decimal('pending_pin_lng', 10, 7).nullable();
    table.timestamp('location_pin_requested_at', { useTz: true }).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.dropColumn('pending_pin_lat');
    table.dropColumn('pending_pin_lng');
    table.dropColumn('location_pin_requested_at');
  });
};
