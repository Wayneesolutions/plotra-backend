/**
 * Admin Operations: Document Verification, AI Voice Call Logs,
 * Site Visit Scheduling & Address-Unlock Tracking
 *
 * Adds the tables the WayneState Pro internal admin panel needs that
 * don't exist yet in Phase 0/1/3. Follows the same conventions as
 * 20260629_01_phase1_listings_and_engagement.js (uuid PKs, tenant_id
 * cascade, snake_case, table.timestamps(true, true)).
 *
 * Does not touch any existing table except one additive, nullable
 * column on whatsapp_threads (unlock tracking needs a pointer back to
 * the thread that triggered the reveal). Safe to run alongside the
 * open Phase 6/7 branch — no naming collisions with rent_vs_buy,
 * billing, or ads tables from that work.
 */

exports.up = async function (knex) {
  // 1. DOCUMENTS — buyer-side document verification (sale deed / mutation / encumbrance)
  await knex.schema.createTable('documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id')
         .notNullable()
         .references('id')
         .inTable('tenants')
         .onDelete('CASCADE');
    table.uuid('listing_id')
         .notNullable()
         .references('id')
         .inTable('listings')
         .onDelete('CASCADE');
    table.uuid('lead_id').references('id').inTable('leads'); // buyer who submitted, if known

    table.string('document_type', 30).notNullable(); // sale_deed / mutation / encumbrance_certificate
    table.text('file_url').notNullable();
    table.string('status', 20).notNullable().defaultTo('pending'); // pending / verified / flagged / rejected
    table.string('verified_by', 255); // lawyer/panel member name, free text for now
    table.text('verification_notes');
    table.timestamp('submitted_at').defaultTo(knex.fn.now());
    table.timestamp('verified_at');
    table.timestamps(true, true);

    table.index(['tenant_id'], 'idx_documents_tenant');
    table.index(['listing_id'], 'idx_documents_listing');
    table.index(['status'], 'idx_documents_status');
  });

  // 2. AI VOICE CALLS — WayneRing/Vapi call log, linked to a lead
  await knex.schema.createTable('ai_voice_calls', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id')
         .notNullable()
         .references('id')
         .inTable('tenants')
         .onDelete('CASCADE');
    table.uuid('lead_id')
         .notNullable()
         .references('id')
         .inTable('leads')
         .onDelete('CASCADE');
    table.uuid('listing_id').references('id').inTable('listings');

    table.string('direction', 10).notNullable().defaultTo('outbound'); // outbound / inbound
    table.string('provider', 30).notNullable().defaultTo('vapi');
    table.string('language', 20); // hindi / punjabi / english
    table.string('outcome', 30); // booked_visit / no_answer / cold / callback_requested / opted_out
    table.integer('duration_seconds');
    table.text('recording_url');
    table.text('transcript_summary');
    table.timestamp('called_at').defaultTo(knex.fn.now());
    table.timestamps(true, true);

    table.index(['tenant_id'], 'idx_calls_tenant');
    table.index(['lead_id'], 'idx_calls_lead');
    table.index(['called_at'], 'idx_calls_time');
  });

  // 3. SITE VISITS — scheduled physical visits (distinct from listing_visits, which are page views)
  await knex.schema.createTable('site_visits', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id')
         .notNullable()
         .references('id')
         .inTable('tenants')
         .onDelete('CASCADE');
    table.uuid('listing_id')
         .notNullable()
         .references('id')
         .inTable('listings')
         .onDelete('CASCADE');
    table.uuid('lead_id')
         .notNullable()
         .references('id')
         .inTable('leads')
         .onDelete('CASCADE');
    table.uuid('assigned_agent_id').references('id').inTable('users');

    table.timestamp('scheduled_for').notNullable();
    table.string('status', 20).notNullable().defaultTo('scheduled'); // scheduled / completed / cancelled / no_show
    table.text('notes');
    table.timestamps(true, true);

    table.index(['tenant_id'], 'idx_visits_sched_tenant');
    table.index(['listing_id'], 'idx_visits_sched_listing');
    table.index(['scheduled_for'], 'idx_visits_sched_time');
  });

  // 4. ADDRESS UNLOCKS — every time a buyer unlocks a redacted address via WhatsApp.
  // This is the event the admin panel's "unlocks" feed and lead-funnel stats are built on.
  await knex.schema.createTable('address_unlocks', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id')
         .notNullable()
         .references('id')
         .inTable('tenants')
         .onDelete('CASCADE');
    table.uuid('listing_id')
         .notNullable()
         .references('id')
         .inTable('listings')
         .onDelete('CASCADE');
    table.uuid('lead_id').references('id').inTable('leads'); // null = unlocked before lead record existed
    table.uuid('whatsapp_thread_id').references('id').inTable('whatsapp_threads');

    table.string('referral_source', 50); // whatsapp_share / soft_prompt / ad / referral
    table.string('ip_city', 100);
    table.timestamp('unlocked_at').defaultTo(knex.fn.now());

    table.index(['tenant_id'], 'idx_unlocks_tenant');
    table.index(['listing_id'], 'idx_unlocks_listing');
    table.index(['unlocked_at'], 'idx_unlocks_time');
  });

  // 5. RLS — same pattern as 20260704_02_phase5_rls.js. All four tables
  // above have a direct tenant_id column, so they get policies too;
  // current_tenant_id() already exists from that migration.
  const RLS_TABLES = ['documents', 'ai_voice_calls', 'site_visits', 'address_unlocks'];
  for (const table of RLS_TABLES) {
    await knex.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);

    await knex.raw(`
      CREATE POLICY ${table}_tenant_isolation_select
        ON ${table}
        FOR SELECT
        USING (
          current_tenant_id() IS NULL
          OR tenant_id = current_tenant_id()
        )
    `);

    await knex.raw(`
      CREATE POLICY ${table}_tenant_isolation_write
        ON ${table}
        FOR ALL
        USING (
          current_tenant_id() IS NULL
          OR tenant_id = current_tenant_id()
        )
        WITH CHECK (
          current_tenant_id() IS NULL
          OR tenant_id = current_tenant_id()
        )
    `);
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('address_unlocks');
  await knex.schema.dropTableIfExists('site_visits');
  await knex.schema.dropTableIfExists('ai_voice_calls');
  await knex.schema.dropTableIfExists('documents');
};
