/**
 * Phase 5 — Tenant Onboarding: adds the tenant_requests table
 * for the public "request access" form and super-admin approval flow.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('tenant_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('business_name', 255).notNullable();
    table.string('contact_name', 255).notNullable();
    table.string('email', 255).notNullable();
    table.string('phone', 20).notNullable();
    table.text('message').nullable();
    table.string('status', 20).notNullable().defaultTo('pending'); // pending / approved / rejected
    // reviewed_by is nullable — a direct admin creation won't have a request row
    table.uuid('reviewed_by').nullable().references('id').inTable('users');
    table.timestamp('reviewed_at').nullable();
    table.timestamps(true, true);

    table.index(['status'], 'idx_tenant_requests_status');
    table.index(['email'], 'idx_tenant_requests_email');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('tenant_requests');
};
