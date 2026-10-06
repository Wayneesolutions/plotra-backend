/**
 * Adds the display/catalog columns the Oct 2026 package structure needs:
 *
 *   category          — which group a plan is shown under on the pricing
 *                       page and in the admin Plans tab ('basic' |
 *                       'basic_with_leads'; NULL = ungrouped/legacy plan).
 *   discount_percent  — the "% off" badge shown next to the price. Purely
 *                       a label: price_inr stays the amount shown and the
 *                       amount billed, nothing is computed from this.
 *   max_users         — users included in the plan (e.g. 4 on Multi User).
 *   included_leads    — leads included in the plan (e.g. 30 / 50).
 *
 * max_users and included_leads are catalog data only for now — nothing
 * enforces them yet (team invites and marketplace lead delivery do not
 * read these columns). All four are nullable so every existing plan row
 * is left exactly as it was.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('plans', (table) => {
    table.string('category', 40).nullable();
    table.integer('discount_percent').nullable();
    table.integer('max_users').nullable();
    table.integer('included_leads').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('plans', (table) => {
    table.dropColumn('category');
    table.dropColumn('discount_percent');
    table.dropColumn('max_users');
    table.dropColumn('included_leads');
  });
};
