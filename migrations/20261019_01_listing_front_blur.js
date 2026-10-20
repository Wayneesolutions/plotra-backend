/**
 * Dealer-chosen blur areas on a live listing's street view.
 *
 * Once the location is final, the dealer can mark signboards or a house number
 * on the front of the property to be hidden from buyers. Stored as
 * { panoId, regions: [{ heading, pitch, width, height }] } in degrees, in the
 * coordinates of the one panorama buyers are shown (panoId). If the location
 * changes the panorama changes, so the saved areas are ignored unless panoId
 * still matches (publicListingController.js).
 *
 * Additive only; `down` reverses it.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.jsonb('front_blur').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('front_blur');
  });
};
