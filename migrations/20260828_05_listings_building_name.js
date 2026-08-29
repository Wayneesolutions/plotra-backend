/**
 * building_name (the specific project/society/mall a listing is inside —
 * see listingExtractionService.js) was extracted on every intake message
 * but never actually persisted to the listings row itself, only used
 * transiently to auto-link a builder profile. Needed as a durable column
 * now that resolvedLocalityService.js keys its cache off it — the cache
 * lookup/write needs to read a listing's building_name at approval time and
 * pin-correction time, both of which happen well after the original
 * extraction message is gone.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.string('building_name', 255).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('building_name');
  });
};
