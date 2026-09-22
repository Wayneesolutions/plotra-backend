/**
 * Part 2, build-order item 6 — calling-minute metering + overage billing.
 *
 * dealerOpsController.js already has a MONTHLY_CALL_CAP safety guard (a
 * flat call-count cap, env-configurable, same for every tenant regardless
 * of plan — see its own comment: "the per-plan 'included AI calling
 * minutes'... is a pricing/revenue concept for a future billing pass").
 * This migration is that pass. It's a distinct, additional concept from
 * the safety cap, not a replacement for it — the cap stays as pure abuse
 * prevention; these two new columns are what "100 minutes/month included,
 * then billed per-minute" (Tier 3) actually needs.
 *
 * Both nullable, and null on every existing plan by default — a plan
 * without included_calling_minutes set is treated as "no included-minutes
 * concept, no overage ever computed," which is exactly today's behavior
 * for starter/growth/unlimited (calling has always been ungated, uncapped
 * by minutes). Only a plan that explicitly sets these two fields (i.e. the
 * future Tier 3 row) gets overage tracked at all.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('plans', (table) => {
    table.integer('included_calling_minutes').nullable(); // NULL = no per-minute cap/overage concept for this plan
    table.integer('overage_rate_paise_per_minute').nullable();
  });

  await knex.raw(`
    ALTER TABLE plans
      ADD CONSTRAINT chk_calling_overage_rate_needs_included_minutes
        CHECK (overage_rate_paise_per_minute IS NULL OR included_calling_minutes IS NOT NULL)
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE plans DROP CONSTRAINT IF EXISTS chk_calling_overage_rate_needs_included_minutes`);
  await knex.schema.alterTable('plans', (table) => {
    table.dropColumn('included_calling_minutes');
    table.dropColumn('overage_rate_paise_per_minute');
  });
};
