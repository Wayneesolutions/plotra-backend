/**
 * Phase 6: Rent-vs-Buy Calculator + Ad Monetization
 *
 * Adds the two revenue features from the Property Visual Explorer
 * monetization plan: a public self-serve rent-vs-buy calculator (lead
 * magnet + data capture) and a direct-sold display ad system for the
 * public property pages.
 *
 * Design notes:
 * - city_market_defaults / state_stamp_duty_rates are lookup/config tables,
 *   not tenant data — one shared set of assumptions platform-wide. No RLS.
 * - rent_vs_buy_calculations DOES carry an optional tenant_id (set when the
 *   calculator is run from a specific dealer's property page) so it gets
 *   the same RLS treatment as the Phase 5 tables — public runs (tenant_id
 *   NULL) remain visible per the existing "no context set = no restriction"
 *   convention; dashboard queries scoped to a tenant only see their own.
 * - ad_placements / ad_events are NOT tenant data — these are ads Wayne E
 *   Solutions sells directly to advertisers (interior designers, home loan
 *   providers, etc.) and are shown across any tenant's public pages. No
 *   tenant_id column, no RLS — same trust boundary as a public route.
 */

exports.up = async function (knex) {
  // 1. Config: city-level market assumptions (appreciation rate, avg rent)
  await knex.schema.createTable('city_market_defaults', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('city', 100).unique().notNullable();
    table.decimal('appreciation_rate', 5, 2).notNullable().defaultTo(5.00);
    table.decimal('avg_rent_per_sqft', 8, 2).notNullable().defaultTo(15.00);
    table.timestamps(true, true);
  });

  // 2. Config: state-level stamp duty + registration rates
  await knex.schema.createTable('state_stamp_duty_rates', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('state', 100).unique().notNullable();
    table.decimal('rate_percent', 5, 2).notNullable();
    table.decimal('registration_fee_percent', 5, 2).notNullable().defaultTo(1.00);
    table.timestamps(true, true);
  });

  // 3. Every calculator run — powers "how many buyers used the calculator
  //    on my listing" once a dashboard widget wants it (not built yet).
  await knex.schema.createTable('rent_vs_buy_calculations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
    table.uuid('property_id').nullable().references('id').inTable('listings').onDelete('SET NULL');
    table.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
    table.jsonb('input_params').notNullable();
    table.jsonb('result').notNullable();
    table.timestamps(true, true);

    table.index(['tenant_id'], 'idx_rvb_calc_tenant');
    table.index(['property_id'], 'idx_rvb_calc_property');
  });

  // 4. Ad inventory — direct-sold display campaigns
  await knex.schema.createTable('ad_placements', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('advertiser_name', 150).notNullable();
    table.string('position', 50).notNullable(); // 'calculator_result' | 'listing_sidebar' | etc.
    table.string('image_url', 512).notNullable();
    table.string('click_url', 512).notNullable();
    table.string('city_filter', 100).nullable(); // null = shown in every city
    table.string('revenue_model', 20).notNullable().defaultTo('flat_fee'); // 'cpl' | 'flat_fee'
    table.timestamp('active_from').notNullable();
    table.timestamp('active_to').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamps(true, true);

    table.index(['is_active', 'active_from', 'active_to'], 'idx_ad_placements_serving');
    table.index(['position'], 'idx_ad_placements_position');
  });

  // 5. Ad telemetry — impressions/clicks/leads, for reporting + future CPL billing
  await knex.schema.createTable('ad_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('placement_id').notNullable().references('id').inTable('ad_placements').onDelete('CASCADE');
    table.string('event_type', 20).notNullable(); // 'impression' | 'click' | 'lead'
    table.string('session_reference', 255).nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index(['placement_id'], 'idx_ad_events_placement');
    table.index(['event_type'], 'idx_ad_events_type');
  });

  // 6. RLS on rent_vs_buy_calculations — same pattern as Phase 5's
  //    current_tenant_id() helper (created in 20260704_02_phase5_rls.js).
  //    Public runs (no tenant context set) stay visible everywhere, exactly
  //    like the public listing routes; dashboard queries see only their own.
  await knex.raw('ALTER TABLE rent_vs_buy_calculations ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE rent_vs_buy_calculations FORCE ROW LEVEL SECURITY');

  await knex.raw(`
    CREATE POLICY rent_vs_buy_calculations_tenant_isolation_select
      ON rent_vs_buy_calculations
      FOR SELECT
      USING (
        current_tenant_id() IS NULL
        OR tenant_id IS NULL
        OR tenant_id = current_tenant_id()
      )
  `);

  await knex.raw(`
    CREATE POLICY rent_vs_buy_calculations_tenant_isolation_write
      ON rent_vs_buy_calculations
      FOR ALL
      USING (
        current_tenant_id() IS NULL
        OR tenant_id IS NULL
        OR tenant_id = current_tenant_id()
      )
      WITH CHECK (
        current_tenant_id() IS NULL
        OR tenant_id IS NULL
        OR tenant_id = current_tenant_id()
      )
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP POLICY IF EXISTS rent_vs_buy_calculations_tenant_isolation_select ON rent_vs_buy_calculations');
  await knex.raw('DROP POLICY IF EXISTS rent_vs_buy_calculations_tenant_isolation_write ON rent_vs_buy_calculations');

  await knex.schema.dropTableIfExists('ad_events');
  await knex.schema.dropTableIfExists('ad_placements');
  await knex.schema.dropTableIfExists('rent_vs_buy_calculations');
  await knex.schema.dropTableIfExists('state_stamp_duty_rates');
  await knex.schema.dropTableIfExists('city_market_defaults');
};
