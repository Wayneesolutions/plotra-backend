/**
 * Plotraa Assistant (src/services/assistantService.js).
 *
 * - assistant_messages: the assistant's own conversation memory, keyed by
 *   phone + audience ('agent' | 'visitor' | 'buyer'). Lets a follow-up like
 *   "aur leads kaise milte hain?" be answered in context. Only the assistant's
 *   turns live here; listing intake keeps its own agent_draft_messages.
 * - support_requests: someone needs a human. Created when an agent reports a
 *   problem, anyone asks for a call back, or a complaint comes in. The team
 *   is alerted (WhatsApp + email) and works the queue from the super-admin
 *   "Support" tab: open -> contacted -> closed.
 *
 * Additive only; `down` drops both tables.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('assistant_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('phone', 20).notNullable();
    table.string('audience', 20).notNullable(); // agent | visitor | buyer
    table.uuid('tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.string('direction', 10).notNullable(); // inbound | outbound
    table.text('body').notNullable();
    table.string('action', 30).nullable(); // what the assistant decided on an outbound turn
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['phone', 'audience', 'created_at'], 'idx_assistant_messages_phone');
  });

  await knex.schema.createTable('support_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('phone', 20).notNullable();
    table.string('name', 255).nullable();
    table.string('audience', 20).notNullable(); // agent | visitor | buyer
    table.string('kind', 20).notNullable().defaultTo('problem'); // problem | callback | complaint
    table.uuid('tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.text('summary').nullable();
    table.text('last_message').nullable();
    table.integer('message_count').notNullable().defaultTo(1);
    table.string('status', 20).notNullable().defaultTo('open'); // open | contacted | closed
    table.text('admin_notes').nullable();
    table.timestamp('alerted_at', { useTz: true }).nullable();
    table.uuid('contacted_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('contacted_at', { useTz: true }).nullable();
    table.timestamp('closed_at', { useTz: true }).nullable();
    table.timestamps(true, true);
    table.index(['status', 'created_at'], 'idx_support_requests_status');
    table.index(['phone', 'status'], 'idx_support_requests_phone');
  });
  await knex.raw("ALTER TABLE support_requests ADD CONSTRAINT chk_support_requests_status CHECK (status IN ('open','contacted','closed'))");
  await knex.raw("ALTER TABLE support_requests ADD CONSTRAINT chk_support_requests_kind CHECK (kind IN ('problem','callback','complaint'))");
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('support_requests');
  await knex.schema.dropTableIfExists('assistant_messages');
};
