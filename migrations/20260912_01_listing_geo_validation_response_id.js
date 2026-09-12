/**
 * Stores the responseId returned by Google's Address Validation API so we can
 * send provideValidationFeedback after a dealer confirms or corrects a pin.
 * NULL for listings geocoded via the old Geocoding API path — the feedback call
 * in publicListingController.js / agentIntakeController.js is guarded by a
 * null-check so no-op for those rows.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.text('geo_validation_response_id').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('geo_validation_response_id');
  });
};
