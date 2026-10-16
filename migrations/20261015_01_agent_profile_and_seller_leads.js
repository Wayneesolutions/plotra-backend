/**
 * Two features:
 *
 * 1. Agent profile shown on the public property page (below location/map):
 *    rating, years of experience, RERA-certified flag. Stored on the tenant
 *    (the dealer behind the listing) and set by super-admin for now. The
 *    agent's name is deliberately NOT part of the public payload.
 *
 * 2. Seller leads: visitors of the buyer-facing site can submit their own
 *    property for sale. Rows land here for super-admin, who can forward each
 *    to any dealer (assigned_tenant_id); on assignment a normal `leads` row
 *    is also created for that dealer so it shows up in their dashboard.
 *
 * seller_leads has no RLS — same as call_enquiries: written by the public
 * route, read only by super-admin routes.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('tenants', (table) => {
    table.decimal('agent_rating', 2, 1).nullable();            // 0.0 - 5.0
    table.integer('agent_experience_years').nullable();
    table.boolean('rera_certified').notNullable().defaultTo(false);
  });
  await knex.raw(`
    ALTER TABLE tenants ADD CONSTRAINT tenants_agent_rating_range
      CHECK (agent_rating IS NULL OR (agent_rating >= 0 AND agent_rating <= 5))
  `);

  await knex.schema.createTable('seller_leads', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('name', 255).notNullable();
    table.string('phone', 20).notNullable();
    table.string('email', 255);
    table.string('property_type', 50);
    table.string('city', 100);
    table.string('locality', 255);
    table.text('address');
    table.string('expected_price', 100);
    table.string('size_text', 100);
    table.text('description');
    table.string('source', 50).notNullable().defaultTo('web_sell');
    // new | assigned | closed
    table.string('status', 20).notNullable().defaultTo('new');
    table.uuid('assigned_tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
    table.uuid('assigned_lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
    table.timestamp('assigned_at');
    table.uuid('assigned_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.text('admin_notes');
    table.timestamps(true, true);

    table.index(['status', 'created_at'], 'idx_seller_leads_status_date');
    table.index(['assigned_tenant_id'], 'idx_seller_leads_tenant');
    table.index(['phone'], 'idx_seller_leads_phone');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seller_leads');
  await knex.raw('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_agent_rating_range');
  await knex.schema.alterTable('tenants', (table) => {
    table.dropColumn('agent_rating');
    table.dropColumn('agent_experience_years');
    table.dropColumn('rera_certified');
  });
};
