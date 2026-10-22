/**
 * 22 Oct 2026 fixes (visitor role flow, live plans, Razorpay, templates).
 *
 * - whatsapp_conversations: where a visitor on the Plotraa number is in the
 *   role menu / step-by-step flow (buyer, owner, dealer). One row per phone.
 * - whatsapp_contact_windows: last inbound message per phone, so the outbound
 *   worker knows whether free text is allowed (24h) or a template is needed.
 * - whatsapp_template_sends: every template send with Meta's message id and
 *   the error, if any; delivery receipts from Meta update it.
 * - users.selected_plan_key: the plan a dealer picked from the LIVE plans table
 *   (replaces the old hardcoded packages Lite/Growth/Unlimited).
 * - plans.qr_code_url: optional payment QR per plan (the old packages had one).
 * - razorpay_payment_links: every payment link we create (notes.product =
 *   plotraa, because the Razorpay account is shared with Waynur).
 * - payment_submissions: receipt photo becomes optional (online payments have
 *   none); plan_key / source / razorpay ids added.
 * - seller_leads.photo_urls: photos an owner sends on WhatsApp.
 * - The old packages (Lite/Growth/Unlimited) are deactivated, not deleted.
 *
 * Additive; `down` reverses it.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('whatsapp_conversations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('phone', 20).notNullable().unique();
    table.string('role', 20).nullable(); // buyer | owner | dealer
    table.string('step', 40).notNullable().defaultTo('role'); // role | <role step> | done
    table.jsonb('data').notNullable().defaultTo('{}');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('whatsapp_contact_windows', (table) => {
    table.string('phone', 20).primary();
    table.timestamp('last_inbound_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('whatsapp_template_sends', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('job_id', 100).nullable().unique();
    table.string('template_name', 120).notNullable();
    table.string('lang', 20).nullable();
    table.string('phone', 20).notNullable();
    table.uuid('tenant_id').nullable();
    table.integer('param_count').notNullable().defaultTo(0);
    table.jsonb('body_params').nullable();
    table.string('meta_message_id', 200).nullable();
    table.string('status', 20).notNullable().defaultTo('queued'); // queued | sent | delivered | read | failed
    table.integer('attempts').notNullable().defaultTo(0);
    table.text('error').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['meta_message_id'], 'idx_template_sends_meta_id');
    table.index(['phone', 'created_at'], 'idx_template_sends_phone');
    table.index(['status', 'created_at'], 'idx_template_sends_status');
  });

  await knex.schema.alterTable('users', (table) => {
    table.string('selected_plan_key', 50).nullable();
  });

  await knex.schema.alterTable('plans', (table) => {
    table.string('qr_code_url', 500).nullable();
  });

  await knex.schema.createTable('razorpay_payment_links', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('plan_key', 50).notNullable();
    table.integer('amount_inr').notNullable();
    table.string('razorpay_link_id', 100).notNullable().unique();
    table.string('reference_id', 100).notNullable().unique();
    table.string('short_url', 500).notNullable();
    table.string('status', 20).notNullable().defaultTo('created'); // created | paid | expired | cancelled
    table.string('razorpay_payment_id', 100).nullable().unique();
    table.timestamp('expires_at', { useTz: true }).nullable();
    table.timestamp('paid_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['user_id', 'status'], 'idx_razorpay_links_user');
  });

  await knex.raw('ALTER TABLE payment_submissions ALTER COLUMN receipt_photo_url DROP NOT NULL');
  await knex.schema.alterTable('payment_submissions', (table) => {
    table.string('plan_key', 50).nullable();
    table.string('source', 20).notNullable().defaultTo('receipt'); // receipt | razorpay
    table.string('razorpay_payment_id', 100).nullable();
  });

  await knex.schema.alterTable('seller_leads', (table) => {
    table.jsonb('photo_urls').nullable();
  });

  // The hardcoded Lite/Growth/Unlimited catalogue is retired: dealers pick
  // from the live `plans` table. Rows stay (users.package_id may point at
  // them) but are no longer offered.
  await knex('packages').whereIn('name', ['Lite', 'Growth', 'Unlimited']).update({ is_active: false });
};

exports.down = async function (knex) {
  await knex('packages').whereIn('name', ['Lite', 'Growth', 'Unlimited']).update({ is_active: true });
  await knex.schema.alterTable('seller_leads', (table) => { table.dropColumn('photo_urls'); });
  await knex.schema.alterTable('payment_submissions', (table) => {
    table.dropColumn('plan_key');
    table.dropColumn('source');
    table.dropColumn('razorpay_payment_id');
  });
  await knex.schema.dropTableIfExists('razorpay_payment_links');
  await knex.schema.alterTable('plans', (table) => { table.dropColumn('qr_code_url'); });
  await knex.schema.alterTable('users', (table) => { table.dropColumn('selected_plan_key'); });
  await knex.schema.dropTableIfExists('whatsapp_template_sends');
  await knex.schema.dropTableIfExists('whatsapp_contact_windows');
  await knex.schema.dropTableIfExists('whatsapp_conversations');
};
