/**
 * Two features:
 *
 * 1. Per-listing agent WhatsApp attribution. Today a listing's buyer-
 *    facing "Get more details on WhatsApp" button always goes to the
 *    tenant's single whatsapp_number — fine for a small agency, but a
 *    multi-agent one wants a specific listing to route to whichever
 *    team member actually handles it, not one shared front-desk number.
 *
 *    listings.assigned_agent_id (nullable FK -> users, ON DELETE SET
 *    NULL so removing a team member never breaks a listing) lets a
 *    dealer pick a specific team member (see userInviteController.js —
 *    team members already have their own `phone`) as that listing's
 *    buyer-facing contact. Null means "use the tenant's default number,"
 *    same behavior as today, so this is fully backward compatible.
 *
 *    Gated to growth/unlimited plans (plans.multi_agent_whatsapp) —
 *    matches the existing plan tiering, which already advertises
 *    "Dedicated WhatsApp number" as a growth+ feature vs. starter's
 *    "Shared WhatsApp number."
 *
 * 2. Nothing schema-wise needed for listing search/filter (area, price
 *    range, property type) — all filterable on columns that already
 *    exist (raw_address, formatted_address, price, property_type). Only
 *    the query logic in listingController.js and the dashboard UI needed
 *    building, not a migration.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('plans', (table) => {
    table.boolean('multi_agent_whatsapp').notNullable().defaultTo(false);
  });

  await knex('plans').whereIn('key', ['growth', 'unlimited']).update({ multi_agent_whatsapp: true });

  await knex.schema.alterTable('listings', (table) => {
    table.uuid('assigned_agent_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('assigned_agent_id');
  });
  await knex.schema.alterTable('plans', (table) => {
    table.dropColumn('multi_agent_whatsapp');
  });
};
