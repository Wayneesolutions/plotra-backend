/**
 * Schema-only groundwork for the new three-tier plan system (Tier 1
 * WhatsApp Only / Tier 2 Dashboard / Tier 3 Calling — see the
 * implementation brief). Deliberately narrow: adds the columns future
 * gates will read, seeds them with values that preserve TODAY's actual
 * behavior on the existing starter/growth/unlimited plans, and changes
 * no runtime logic. The gates themselves (dashboard-login block,
 * calling-access check, monthly listing counting, multi-number routing)
 * are separate, later PRs — this just gives them somewhere to read from.
 *
 * Defaults matter here specifically because nothing is currently gated:
 * every logged-in tenant today gets full dashboard access and (where
 * WayneRing is configured) full calling access regardless of plan, and
 * every tenant has exactly one WhatsApp number. So dashboard_access and
 * calling_access default TRUE (not false, unlike multi_agent_whatsapp's
 * precedent in 20260821_04) and max_whatsapp_numbers defaults to 1 — an
 * unmigrated/legacy plan should keep behaving exactly as it does today
 * once the real gate checks land, not silently lose access.
 *
 * monthly_listing_limit is added alongside the existing (lifetime)
 * listing_limit rather than replacing it — listingService.js's counting
 * logic isn't touched by this migration, so nothing changes yet. Whether
 * to actually retire listing_limit in favor of this is for the PR that
 * switches the counting logic to be month-scoped.
 *
 * This migration does NOT create the new Tier 1/2/3 plan rows themselves
 * (₹1,999 / ₹4,999 / ₹14,999, 40-50 / 100 / 200 monthly listings) — what
 * happens to tenants currently on starter/growth/unlimited (migrated to
 * a new tier? kept as legacy plans?) is a business decision, not
 * something to resolve inside a schema migration.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('plans', (table) => {
    table.boolean('dashboard_access').notNullable().defaultTo(true);
    table.boolean('calling_access').notNullable().defaultTo(true);
    table.integer('max_whatsapp_numbers').notNullable().defaultTo(1);
    table.integer('monthly_listing_limit').nullable(); // NULL = not yet migrated to monthly counting; see listingService.js
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('plans', (table) => {
    table.dropColumn('dashboard_access');
    table.dropColumn('calling_access');
    table.dropColumn('max_whatsapp_numbers');
    table.dropColumn('monthly_listing_limit');
  });
};
