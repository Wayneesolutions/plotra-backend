/**
 * Seeds the real agent package catalog (`packages` table, migration
 * 20260921_02) — confirmed root cause of the WhatsApp "select your plan"
 * menu being empty: the table existed with a working admin CRUD API
 * (PR #32) and admin UI (frontend PR #21), but nothing had ever inserted
 * a row into it, so sendPackageSelectionPrompt's `getActivePackagesInMenuOrder`
 * query always returned zero rows.
 *
 * Values (Lite/Growth/Unlimited at ₹3,000/₹10,000/₹20,000) as given
 * directly by the user in the task brief, not re-derived from any doc.
 *
 * `packages.name` has no unique constraint (see 20260921_02) so a DB-level
 * ON CONFLICT guard isn't available here — knex's own migration-tracking
 * table already guarantees this file only runs once, same as every other
 * seed-via-migration in this codebase (e.g. the `plans` seed in
 * 20260706_01_billing.js), but the explicit existence check below is a
 * second, cheap guard against duplicate rows if this ever gets run twice
 * by hand outside the normal migrate flow.
 */

exports.up = async function (knex) {
  const existing = await knex('packages').whereIn('name', ['Lite', 'Growth', 'Unlimited']).select('name');
  const existingNames = new Set(existing.map((r) => r.name));

  const rows = [
    { name: 'Lite', amount_inr: 3000, sort_order: 1, is_active: true },
    { name: 'Growth', amount_inr: 10000, sort_order: 2, is_active: true },
    { name: 'Unlimited', amount_inr: 20000, sort_order: 3, is_active: true },
  ].filter((r) => !existingNames.has(r.name));

  if (rows.length) await knex('packages').insert(rows);
};

exports.down = async function (knex) {
  await knex('packages').whereIn('name', ['Lite', 'Growth', 'Unlimited']).del();
};
