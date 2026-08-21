/**
 * Some dealers don't want to publicly show a price ("price on request" is
 * common in the Punjab real-estate market for premium/negotiable listings).
 * `price` was NOT NULL from the original phase-1 migration
 * (20260629_01_phase1_listings_and_engagement.js) — this relaxes that so a
 * listing can be created/edited without one.
 *
 * Every place that reads listing.price for display (ogPreviewController.js,
 * publicListingController.js, vocallmWorker.js, PropertyView.jsx on the
 * frontend) was updated alongside this migration to handle a null price as
 * "Price on request" rather than formatting it as ₹0/NaN.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.decimal('price', 14, 2).nullable().alter();
  });
};

exports.down = async function (knex) {
  // Reversing this would fail if any row has a null price by then — leaving
  // that to be handled manually at rollback time rather than silently
  // deleting/coercing real data.
  await knex.schema.alterTable('listings', (table) => {
    table.decimal('price', 14, 2).notNullable().alter();
  });
};
