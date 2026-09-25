/**
 * Ad Placements: default ("house") ads + uploaded images
 *
 * - is_default: a per-position fallback ad (e.g. a Plotraa promo) that is
 *   served whenever no paid campaign matches that position, so the
 *   calculator_result / listing_footer slots are never empty. Only one
 *   default per position (enforced by a partial unique index).
 * - active_from / active_to become nullable: a default ad has no campaign
 *   window — it runs until it's deactivated or replaced. Paid campaigns
 *   still require both dates (validated in adminAdsController.js).
 * - image_url widened to 1024: S3 URLs of uploaded images fit easily in
 *   512, but pasted CDN URLs with query strings sometimes don't.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('ad_placements', (table) => {
    table.boolean('is_default').notNullable().defaultTo(false);
  });

  await knex.raw('ALTER TABLE ad_placements ALTER COLUMN active_from DROP NOT NULL');
  await knex.raw('ALTER TABLE ad_placements ALTER COLUMN active_to DROP NOT NULL');
  await knex.raw('ALTER TABLE ad_placements ALTER COLUMN image_url TYPE varchar(1024)');

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_placements_default_per_position
      ON ad_placements (position)
      WHERE is_default = true
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS uq_ad_placements_default_per_position');

  // Backfill any null windows before restoring NOT NULL.
  await knex.raw("UPDATE ad_placements SET active_from = COALESCE(active_from, created_at, now())");
  await knex.raw("UPDATE ad_placements SET active_to = COALESCE(active_to, now() + interval '10 years')");
  await knex.raw('ALTER TABLE ad_placements ALTER COLUMN active_from SET NOT NULL');
  await knex.raw('ALTER TABLE ad_placements ALTER COLUMN active_to SET NOT NULL');

  await knex.schema.alterTable('ad_placements', (table) => {
    table.dropColumn('is_default');
  });
};
