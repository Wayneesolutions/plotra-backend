/**
 * Agent self-registration flow — lets a prospective agent text a Plotra
 * WhatsApp number directly ("join as agent") instead of the tenant owner
 * having to invite them first (userInviteController.js's existing invite
 * flow still exists and is untouched; this is an additional, self-service
 * entry point).
 *
 * pending_agent_signups holds the conversational collection state AND the
 * owner-facing review queue in one table (no separate drafts table): a row
 * is created the moment "join as agent" is detected, `accumulated_text`
 * grows with each follow-up message (same debounce+GPT-extraction pattern
 * as agent_listing_drafts), and `name`/`address` are filled in once
 * extraction resolves them. The dashboard list endpoint only surfaces rows
 * where both are present — see agentSignupController.js — so an
 * in-progress conversation the agent hasn't finished isn't shown to the
 * owner as something actionable yet.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('pending_agent_signups', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id')
         .notNullable()
         .references('id')
         .inTable('tenants')
         .onDelete('CASCADE');

    table.string('name', 255).nullable();
    table.string('phone', 20).notNullable(); // known immediately from the inbound WhatsApp sender, normalized (+91...)
    table.text('address').nullable();

    // pending -> approved / rejected. Plain varchar, no DB check constraint
    // — matches the rest of this codebase's status columns (tenant_requests,
    // agent_listing_drafts).
    table.string('status', 20).notNullable().defaultTo('pending');

    // Raw conversation text accumulated across messages, re-extracted in
    // full each pass — same rationale as agent_listing_drafts.accumulated_text.
    table.text('accumulated_text').notNullable().defaultTo('');

    table.timestamps(true, true);

    table.index(['tenant_id', 'status'], 'idx_pending_agent_signups_tenant_status');
  });

  // One live signup conversation per phone per tenant — a repeated "join as
  // agent" (or a stray extra message) from the same number reuses the
  // existing pending row instead of piling up duplicates.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_pending_agent_signups_one_pending_per_phone
      ON pending_agent_signups (tenant_id, phone)
      WHERE status = 'pending'
  `);

  await knex.raw(`ALTER TABLE pending_agent_signups ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE pending_agent_signups FORCE ROW LEVEL SECURITY`);

  await knex.raw(`
    CREATE POLICY pending_agent_signups_tenant_isolation_select
      ON pending_agent_signups
      FOR SELECT
      USING (is_service_context() OR tenant_id = current_tenant_id())
  `);
  await knex.raw(`
    CREATE POLICY pending_agent_signups_tenant_isolation_write
      ON pending_agent_signups
      FOR ALL
      USING (is_service_context() OR tenant_id = current_tenant_id())
      WITH CHECK (is_service_context() OR tenant_id = current_tenant_id())
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP POLICY IF EXISTS pending_agent_signups_tenant_isolation_select ON pending_agent_signups`);
  await knex.raw(`DROP POLICY IF EXISTS pending_agent_signups_tenant_isolation_write ON pending_agent_signups`);
  await knex.schema.dropTableIfExists('pending_agent_signups');
};
