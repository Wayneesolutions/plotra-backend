/**
 * Phase 7: Billing
 *
 * Adds what's needed to actually charge tenants via Razorpay:
 * - tenants gains subscription_status + current_period_end (billing state)
 * - payment_events logs every order/payment attempt for audit + investor
 *   reporting ("here's our real MRR", not a guess)
 *
 * Design notes:
 * - Uses one-time Razorpay Orders (not the Subscriptions API) so this works
 *   without pre-configuring subscription plans in the Razorpay dashboard —
 *   each renewal is its own order, verified, and extends current_period_end
 *   by 30 days. Simpler to stand up; revisit Subscriptions API later if
 *   auto-recurring billing (no manual renewal click) becomes a priority.
 * - payment_events is NOT tenant-RLS-protected the same way dashboard data
 *   is — only accessed via billingController (tenant-scoped queries) and
 *   the admin panel (super_admin), both of which filter explicitly.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('tenants', (table) => {
    table.string('razorpay_customer_id', 100).nullable();
    table.string('subscription_status', 20).notNullable().defaultTo('trialing'); // trialing | active | past_due | cancelled
    table.timestamp('current_period_end').nullable();
  });

  await knex.schema.createTable('payment_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('razorpay_order_id', 100).notNullable().unique();
    table.string('razorpay_payment_id', 100).nullable();
    table.string('plan', 50).notNullable();
    table.integer('amount_paise').notNullable(); // Razorpay amounts are always paise, integer
    table.string('currency', 10).notNullable().defaultTo('INR');
    table.string('status', 20).notNullable().defaultTo('created'); // created | paid | failed
    table.jsonb('raw_webhook_payload').nullable();
    table.timestamps(true, true);

    table.index(['tenant_id'], 'idx_payment_events_tenant');
    table.index(['status'], 'idx_payment_events_status');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('payment_events');
  await knex.schema.alterTable('tenants', (table) => {
    table.dropColumn('razorpay_customer_id');
    table.dropColumn('subscription_status');
    table.dropColumn('current_period_end');
  });
};
