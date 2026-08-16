/**
 * "Builder Due Diligence" — for mega-project listings, a buyer-facing sheet
 * covering the builder company's delivery history, leadership, financial
 * condition, and any reported legal issues.
 *
 * This is materially higher legal risk than Local Intelligence (real named
 * companies/individuals, not just a locality) — false claims here are a real
 * defamation risk if ungrounded. Three independent safeguards, only two of
 * which are in this migration:
 *   1. App-code filter (groundedResearchService.filterCitedItems()) — drops
 *      anything without a real source_url before an INSERT is even attempted.
 *   2. THIS MIGRATION: source_url is NOT NULL at the schema level — a claim
 *      cannot be persisted without a citation even if the code filter has a bug.
 *   3. Human moderation gate (builderProfileController.js) — moderation_status
 *      defaults 'pending_review'; the public endpoint only ever returns data
 *      once a person explicitly flips it to 'published'.
 *
 * builder_profiles is deliberately a GLOBAL table (no tenant_id, no RLS) —
 * a builder is a real external company, not any one tenant's private data,
 * and the same builder's profile is researched once and reused across every
 * listing (possibly from different tenants) that links to it. Same
 * no-tenant-scoping precedent as the existing `plans` table.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('builder_profiles', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('company_name', 255).notNullable();
    // lowercase/trimmed dedup key — set by the controller, not the DB, so the
    // normalization logic lives in one place (JS), not duplicated in SQL.
    table.string('normalized_name', 255).notNullable().unique();

    table.jsonb('rera_registration_ids'); // [{state, reg_number, source_url}], best-effort
    table.string('mca_cin', 30); // Corporate Identification Number, if found

    // pending -> researching -> completed / failed
    table.string('research_status', 20).notNullable().defaultTo('pending');
    // pending_review -> published / rejected — see safeguard #3 above.
    // Defaults to pending_review deliberately: AI-grounding reduces risk,
    // it does not by itself authorize publishing to the public internet.
    table.string('moderation_status', 20).notNullable().defaultTo('pending_review');
    table.uuid('moderated_by').references('id').inTable('users');
    table.timestamp('moderated_at');
    table.timestamp('last_researched_at');

    table.timestamps(true, true);
  });

  await knex.schema.createTable('builder_profile_claims', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('builder_profile_id')
         .notNullable()
         .references('id')
         .inTable('builder_profiles')
         .onDelete('CASCADE');

    table.string('category', 30).notNullable(); // delivery_history/leadership/financial_condition/rating/legal_issue
    // Must be phrased as attributed reporting ("Reported by X...") at
    // generation time — never as a flat assertion — see
    // groundedResearchService.js's BUILDER_DD_SYSTEM_PROMPT.
    table.text('claim_text').notNullable();
    // Safeguard #2 — see file header. Not nullable, no default.
    table.text('source_url').notNullable();
    table.string('source_title', 500);
    table.date('source_published_date');
    table.string('source_domain', 255);

    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index(['builder_profile_id'], 'idx_builder_claims_profile');
  });

  // Presence of this link (not a boolean flag) marks a listing as a
  // mega-project — more honest than trying to auto-classify off the
  // existing free-text, loosely-normalized property_type field.
  await knex.schema.alterTable('listings', (table) => {
    table.uuid('builder_profile_id').references('id').inTable('builder_profiles');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('builder_profile_id');
  });
  await knex.schema.dropTableIfExists('builder_profile_claims');
  await knex.schema.dropTableIfExists('builder_profiles');
};
