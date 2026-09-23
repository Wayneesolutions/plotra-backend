/**
 * Part 2, build-order item 9 — "update pricing/plan display." The three
 * new tier plans (tier1/tier2/tier3, added in 20260825_04) are meant to
 * be THE plan structure going forward per the brief's "Final tiers"
 * table — but plotra-frontend's pricing page and billing modal are
 * already fully data-driven (they just render whatever
 * GET /api/v1/public/billing/plans returns, no hardcoded plan list to
 * edit), so with both the old and new plans active at once, a prospect
 * would see all six side by side, which isn't the "final tiers" story.
 *
 * Deactivating starter/growth/unlimited (is_active = false) is the
 * correct, narrowly-scoped fix for that: listPlans() (the public pricing
 * endpoint) and updateTenantPlan's target-plan check both already filter
 * on is_active, so this hides the old plans from new signups' pricing
 * view and blocks new checkouts/plan-assignments against them — WITHOUT
 * touching a single existing tenant. tenants.plan is a plain string
 * column with no FK to plans, so a tenant already on 'starter' keeps
 * working exactly as before (their billing, their listing_limit check,
 * their multi_agent_whatsapp/max_whatsapp_numbers gate — nothing reads
 * is_active except the two paths above). Fully reversible with the
 * existing PATCH /api/v1/admin/plans/:key endpoint, no deploy needed,
 * if this call turns out to be wrong.
 *
 * What this deliberately does NOT do: move any tenant off starter/growth/
 * unlimited onto a new tier key, or change those plans' pricing/limits.
 * That remains the explicit business decision flagged when the tier-gate
 * columns were first added (20260825_01) — this migration only affects
 * what NEW signups are offered.
 */

exports.up = async function (knex) {
  await knex('plans').whereIn('key', ['starter', 'growth', 'unlimited']).update({ is_active: false });
};

exports.down = async function (knex) {
  await knex('plans').whereIn('key', ['starter', 'growth', 'unlimited']).update({ is_active: true });
};
