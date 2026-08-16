/**
 * WhatsApp agent-intake & approval flow.
 *
 * Lets a registered agent text listing details into WhatsApp instead of
 * using the dashboard. Adds:
 *   1. users.phone — the only way to recognize an inbound WhatsApp sender
 *      as an agent rather than a buyer. Globally unique, so matching it
 *      also resolves the tenant directly (users.tenant_id) without the
 *      buyer-side phone_number_id/whatsapp_number fallback dance.
 *   2. listings.source — 'dashboard' (default, unchanged behavior) vs
 *      'whatsapp'. Lets geoEnrichmentWorker gate WhatsApp-originated
 *      listings behind agent approval instead of going straight active.
 *   3. agent_listing_drafts — multi-turn WhatsApp conversation state.
 *      Deliberately separate from whatsapp_threads/whatsapp_messages,
 *      which require a lead_id and are shaped for buyer conversations.
 *   4. agent_draft_messages — transcript + webhook-delivery dedup guard
 *      for the above. No RLS policy needed — protected indirectly via its
 *      parent, same precedent as whatsapp_messages/listing_media.
 *   5. listings gains a new status value 'awaiting_approval' (still a
 *      plain varchar, no enum, matching existing convention) and the
 *      public RLS carve-out is widened to include it — narrowly, so
 *      pending/inactive/sold stay non-public.
 */

exports.up = async function (knex) {
  // ---- 1. users.phone ---------------------------------------------------
  await knex.schema.alterTable('users', (table) => {
    table.string('phone', 20).nullable();
  });
  // Partial unique index — only enforced when a phone is actually set, so
  // existing NULL rows (every user today) don't collide with each other.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_users_phone_unique ON users (phone) WHERE phone IS NOT NULL
  `);

  // ---- 2. listings.source -------------------------------------------------
  await knex.schema.alterTable('listings', (table) => {
    table.string('source', 20).notNullable().defaultTo('dashboard'); // 'dashboard' | 'whatsapp'
  });

  // ---- 3. agent_listing_drafts --------------------------------------------
  await knex.schema.createTable('agent_listing_drafts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id')
         .notNullable()
         .references('id')
         .inTable('tenants')
         .onDelete('CASCADE');
    table.uuid('user_id')
         .notNullable()
         .references('id')
         .inTable('users')
         .onDelete('CASCADE');

    // collecting -> extracting -> creating -> enriching -> awaiting_approval -> approved
    table.string('status', 20).notNullable().defaultTo('collecting');

    // Append-only raw agent input. Extraction always re-derives fields from
    // the FULL history, never a single message, so a fact confirmed three
    // messages ago stays confirmed on a later correction pass.
    table.text('accumulated_text').notNullable().defaultTo('');
    table.jsonb('extracted_fields');
    table.jsonb('missing_fields');

    table.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    table.timestamp('last_preview_sent_at');
    table.timestamps(true, true);
  });

  // One live draft per agent at a time — closes the race where two
  // near-simultaneous inbound messages could otherwise create two drafts
  // (or two listings) for the same agent.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_agent_drafts_one_live_per_agent
      ON agent_listing_drafts (tenant_id, user_id)
      WHERE status IN ('collecting', 'extracting', 'creating', 'enriching', 'awaiting_approval')
  `);
  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.index(['listing_id'], 'idx_agent_drafts_listing');
  });

  // ---- 4. agent_draft_messages ---------------------------------------------
  await knex.schema.createTable('agent_draft_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('draft_id')
         .notNullable()
         .references('id')
         .inTable('agent_listing_drafts')
         .onDelete('CASCADE');
    table.string('direction', 10).notNullable(); // outbound / inbound
    table.text('body').notNullable();
    table.string('bsp_message_id', 255);
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index(['draft_id'], 'idx_agent_draft_messages_draft');
  });
  // Dedup guard against duplicate webhook deliveries (BSP retries because
  // our ack was slow) — a message with the same bsp_message_id is a no-op.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_agent_draft_messages_dedup
      ON agent_draft_messages (draft_id, bsp_message_id)
      WHERE bsp_message_id IS NOT NULL
  `);

  // ---- 5. RLS: enable on the new tenant-scoped table, widen public carve-out
  await knex.raw(`ALTER TABLE agent_listing_drafts ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE agent_listing_drafts FORCE ROW LEVEL SECURITY`);

  await knex.raw(`
    CREATE POLICY agent_listing_drafts_tenant_isolation_select
      ON agent_listing_drafts
      FOR SELECT
      USING (is_service_context() OR tenant_id = current_tenant_id())
  `);
  await knex.raw(`
    CREATE POLICY agent_listing_drafts_tenant_isolation_write
      ON agent_listing_drafts
      FOR ALL
      USING (is_service_context() OR tenant_id = current_tenant_id())
      WITH CHECK (is_service_context() OR tenant_id = current_tenant_id())
  `);

  await knex.raw(`DROP POLICY IF EXISTS listings_tenant_isolation_select ON listings`);
  await knex.raw(`
    CREATE POLICY listings_tenant_isolation_select
      ON listings
      FOR SELECT
      USING (
        is_service_context()
        OR tenant_id = current_tenant_id()
        OR (current_tenant_id() IS NULL AND status IN ('active', 'awaiting_approval'))
      )
  `);
  // Write policy is untouched — still tenant-only / service-context-only.
};

exports.down = async function (knex) {
  await knex.raw(`DROP POLICY IF EXISTS listings_tenant_isolation_select ON listings`);
  await knex.raw(`
    CREATE POLICY listings_tenant_isolation_select
      ON listings
      FOR SELECT
      USING (
        is_service_context()
        OR tenant_id = current_tenant_id()
        OR (current_tenant_id() IS NULL AND status = 'active')
      )
  `);

  await knex.raw(`DROP POLICY IF EXISTS agent_listing_drafts_tenant_isolation_select ON agent_listing_drafts`);
  await knex.raw(`DROP POLICY IF EXISTS agent_listing_drafts_tenant_isolation_write ON agent_listing_drafts`);

  await knex.schema.dropTableIfExists('agent_draft_messages');
  await knex.schema.dropTableIfExists('agent_listing_drafts');

  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('source');
  });

  await knex.raw(`DROP INDEX IF EXISTS idx_users_phone_unique`);
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('phone');
  });
};
