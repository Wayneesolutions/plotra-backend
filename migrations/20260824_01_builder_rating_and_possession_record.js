/**
 * Extends builder_profiles with two structured, comparable data points that
 * "Builder Due Diligence" (20260817_03) only ever expressed as free-text
 * cited claims: a numeric overall rating and a possession (delivery)
 * track record. Both are needed to actually rank/compare mega-project
 * listings against each other — you can't sort or badge a prose claim.
 *
 * Same defamation-risk discipline as the claims table, just shaped as
 * columns instead of rows: a CHECK constraint requires a real source_url
 * before either value can be set at all (mirrors safeguard #2 from the
 * claims table — app-code in groundedResearchService.js is safeguard #1,
 * and these still ride under builder_profiles.moderation_status, so
 * safeguard #3 — the human publish gate — already covers them without
 * any change needed there).
 *
 * overall_rating is intentionally NOT an editorial 1-5 score invented by
 * the model — see groundedResearchService.js's updated prompt: it must
 * come from a real published rating/ranking (RERA standing, a credible
 * real-estate ratings platform, a reputable news ranking), same as every
 * other claim here. If no such source exists, both stay null — never a
 * guessed number sitting next to legally-sensitive content.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('builder_profiles', (table) => {
    table.decimal('overall_rating', 2, 1); // e.g. 4.2, out of 5
    table.text('rating_source_url');
    table.string('rating_source_title', 500);

    table.integer('possession_delivered_count'); // projects delivered (on/near schedule, per source)
    table.integer('possession_total_count');      // projects tracked for that record
    table.text('possession_source_url');
    table.string('possession_source_title', 500);
  });

  await knex.raw(`
    ALTER TABLE builder_profiles
      ADD CONSTRAINT chk_rating_needs_source
        CHECK (overall_rating IS NULL OR rating_source_url IS NOT NULL),
      ADD CONSTRAINT chk_possession_needs_source
        CHECK (possession_total_count IS NULL OR possession_source_url IS NOT NULL),
      ADD CONSTRAINT chk_possession_counts_sane
        CHECK (
          possession_delivered_count IS NULL
          OR (possession_total_count IS NOT NULL AND possession_delivered_count <= possession_total_count AND possession_delivered_count >= 0)
        )
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE builder_profiles
      DROP CONSTRAINT IF EXISTS chk_rating_needs_source,
      DROP CONSTRAINT IF EXISTS chk_possession_needs_source,
      DROP CONSTRAINT IF EXISTS chk_possession_counts_sane
  `);
  await knex.schema.alterTable('builder_profiles', (table) => {
    table.dropColumn('overall_rating');
    table.dropColumn('rating_source_url');
    table.dropColumn('rating_source_title');
    table.dropColumn('possession_delivered_count');
    table.dropColumn('possession_total_count');
    table.dropColumn('possession_source_url');
    table.dropColumn('possession_source_title');
  });
};
