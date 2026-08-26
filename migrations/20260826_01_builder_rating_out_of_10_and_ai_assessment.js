/**
 * Extends builder_profiles' rating to support a second, distinct kind of
 * rating alongside the original one from 20260824_01.
 *
 * 20260824_01's overall_rating was intentionally restricted to a real,
 * already-published external rating (RERA standing, a ratings platform, a
 * news ranking) — never something the model computed itself. Per an
 * explicit product decision (2026-08-26), that's being widened: the model
 * may now also SYNTHESIZE an "ability to deliver" assessment (0-10) from
 * the cited claims it already gathered (delivery history, financial
 * condition, legal issues, leadership stability) when no external
 * published ranking exists — see groundedResearchService.js.
 *
 * This is still bound by the same "never a guessed number with nothing
 * behind it" discipline as before, just via a second, distinct form of
 * grounding: rating_basis (a text explanation of which cited facts the
 * score was built from) can now satisfy the not-ungrounded requirement
 * instead of rating_source_url — one or the other must be present
 * whenever overall_rating is set, enforced by the updated CHECK
 * constraint below, same as it always was.
 *
 * overall_rating widens from decimal(2,1) (max 9.9) to decimal(3,1) (max
 * 99.9) — needed simply to represent 10.0 on the new 0-10 scale; existing
 * 0-5-scale values already stored are unaffected (they're within the new,
 * wider range too).
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('builder_profiles', (table) => {
    table.decimal('overall_rating', 3, 1).alter(); // widen: was (2,1) — max 9.9, needed up to 10.0
    table.text('rating_basis'); // set when the rating is a synthesized assessment, not an external citation
    table.boolean('rating_is_ai_assessment').defaultTo(false); // true = Plotra-synthesized; false/existing rows = a real external published rating (20260824_01's original behavior)
  });

  await knex.raw(`
    ALTER TABLE builder_profiles
      DROP CONSTRAINT IF EXISTS chk_rating_needs_source,
      ADD CONSTRAINT chk_rating_needs_grounding
        CHECK (overall_rating IS NULL OR rating_source_url IS NOT NULL OR rating_basis IS NOT NULL)
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE builder_profiles
      DROP CONSTRAINT IF EXISTS chk_rating_needs_grounding,
      ADD CONSTRAINT chk_rating_needs_source
        CHECK (overall_rating IS NULL OR rating_source_url IS NOT NULL)
  `);
  await knex.schema.alterTable('builder_profiles', (table) => {
    table.dropColumn('rating_basis');
    table.dropColumn('rating_is_ai_assessment');
    table.decimal('overall_rating', 2, 1).alter();
  });
};
