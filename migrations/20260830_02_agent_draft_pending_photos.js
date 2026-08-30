/**
 * Fixes a real, user-reported gap: a dealer answering "what type of
 * property?" with a photo + caption (e.g. a photo captioned "commercial
 * property") had that caption silently discarded — Meta puts an image
 * message's caption at messages[0].image.caption, not .text.body, so
 * webhookController.js's parseInboundPayload never even read it, and
 * handleAgentIntakePhoto rejected the photo outright with "describe the
 * property first" whenever no listing existed yet (still 'collecting').
 * Both photos sent while answering that question were lost entirely.
 *
 * pending_photo_urls holds photos uploaded before a listing exists yet
 * (S3 upload still happens immediately, nothing lost) — agentIntakeWorker.js
 * flushes these into listing_media.photo_urls the moment the listing is
 * actually created, then clears this column.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.jsonb('pending_photo_urls').notNullable().defaultTo('[]');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.dropColumn('pending_photo_urls');
  });
};
