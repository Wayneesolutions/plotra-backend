/**
 * Phase 8: Fixes for 8 gaps found in review, plus one more found while
 * fixing them (see README/PR notes for the full list). This migration
 * covers the schema-level changes; app-layer fixes are in the
 * accompanying controller/middleware changes.
 *
 * 1. RLS redesign — the Phase 5 policies allowed ALL rows through whenever
 *    no tenant context was set (current_tenant_id() IS NULL), intended for
 *    public routes. But that same condition is also true whenever a
 *    developer forgets to apply the tenantTransaction middleware on a new
 *    route — which is exactly the bug class RLS is supposed to catch. A
 *    forgotten middleware silently disabled the safety net instead of
 *    tripping it.
 *
 *    New design: three contexts instead of two.
 *      - Tenant context set (dashboard routes)      -> tenant_id match only
 *      - Service context set (admin + webhook routes) -> full access,
 *        because those routes already have their own independent gate
 *        (adminGuard's JWT+role check, or the webhook's HMAC signature) —
 *        tenant matching was never the right control for them anyway.
 *      - Neither set (a route with no auth applied at all, forgotten or
 *        otherwise) -> NO rows on users/tenant_configs/leads/whatsapp_threads.
 *        listings gets one narrow carve-out: status='active' rows only,
 *        since that's the one table the public site genuinely needs to
 *        read with no session state at all.
 *
 * 2. tenants.phone_number_id — Meta Cloud API identifies the receiving
 *    WhatsApp Business number by an opaque phone_number_id, not the raw
 *    phone number. The webhook parser already expected this column to
 *    exist ("resolve below if needed") but it never did, and no resolution
 *    code was ever written — every Meta Cloud API inbound message fell
 *    through to the "oldest active tenant" fallback regardless of which
 *    tenant's number it actually arrived on.
 *
 * 3. plans table — pricing/limits/features were hardcoded JS constants in
 *    billingService.js. Moved to a DB table so an admin can change a
 *    price or a listing limit without a code deploy.
 *
 * 4. password_reset_tokens — no forgot-password flow existed at all.
 */

exports.up = async function (knex) {
  // ---- 1. Service-context helper + RLS redesign -----------------------
  await knex.raw(`
    CREATE OR REPLACE FUNCTION is_service_context()
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $$
      SELECT COALESCE(NULLIF(current_setting('app.is_service_context', true), '')::boolean, false)
    $$
  `);

  const STRICT_TABLES = ['users', 'tenant_configs', 'leads', 'whatsapp_threads'];

  for (const table of STRICT_TABLES) {
    await knex.raw(`DROP POLICY IF EXISTS ${table}_tenant_isolation_select ON ${table}`);
    await knex.raw(`DROP POLICY IF EXISTS ${table}_tenant_isolation_write ON ${table}`);

    await knex.raw(`
      CREATE POLICY ${table}_tenant_isolation_select
        ON ${table}
        FOR SELECT
        USING (is_service_context() OR tenant_id = current_tenant_id())
    `);

    await knex.raw(`
      CREATE POLICY ${table}_tenant_isolation_write
        ON ${table}
        FOR ALL
        USING (is_service_context() OR tenant_id = current_tenant_id())
        WITH CHECK (is_service_context() OR tenant_id = current_tenant_id())
    `);
  }

  // listings keeps a narrow public carve-out: unauthenticated context can
  // only ever see active listings, never pending/draft ones.
  await knex.raw(`DROP POLICY IF EXISTS listings_tenant_isolation_select ON listings`);
  await knex.raw(`DROP POLICY IF EXISTS listings_tenant_isolation_write ON listings`);

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

  await knex.raw(`
    CREATE POLICY listings_tenant_isolation_write
      ON listings
      FOR ALL
      USING (is_service_context() OR tenant_id = current_tenant_id())
      WITH CHECK (is_service_context() OR tenant_id = current_tenant_id())
  `);

  // ---- 5. Same permissive-default flaw existed on rent_vs_buy_calculations
  // (added in migration 20260705_01) — but that table is legitimately
  // different: public calculator runs insert rows with tenant_id = NULL by
  // design (anonymous, not tied to any dealer). The bug isn't that NULL
  // rows are visible — that's correct — it's that the OLD policy also let
  // an accidental no-context session see every OTHER tenant's attributed
  // rows too. Fixed to only auto-allow rows that are actually NULL, not
  // "any row, whenever context happens to be unset."
  await knex.raw(`DROP POLICY IF EXISTS rent_vs_buy_calculations_tenant_isolation_select ON rent_vs_buy_calculations`);
  await knex.raw(`DROP POLICY IF EXISTS rent_vs_buy_calculations_tenant_isolation_write ON rent_vs_buy_calculations`);

  await knex.raw(`
    CREATE POLICY rent_vs_buy_calculations_tenant_isolation_select
      ON rent_vs_buy_calculations
      FOR SELECT
      USING (
        is_service_context()
        OR tenant_id = current_tenant_id()
        OR tenant_id IS NULL
      )
  `);

  await knex.raw(`
    CREATE POLICY rent_vs_buy_calculations_tenant_isolation_write
      ON rent_vs_buy_calculations
      FOR ALL
      USING (is_service_context() OR tenant_id = current_tenant_id() OR tenant_id IS NULL)
      WITH CHECK (is_service_context() OR tenant_id = current_tenant_id() OR tenant_id IS NULL)
  `);

  // ---- 6. Meta Cloud API phone_number_id -------------------------------
  await knex.schema.alterTable('tenants', (table) => {
    table.string('phone_number_id', 100).nullable().unique();
    // Needed to manage/cancel a tenant's recurring subscription (gap #6 —
    // auto-renewal). Nullable since existing tenants pre-date subscriptions.
    table.string('stripe_subscription_id', 100).nullable();
  });

  // ---- 3. plans table ---------------------------------------------------
  await knex.schema.createTable('plans', (table) => {
    table.string('key', 30).primary(); // 'starter' | 'growth' | 'unlimited'
    table.string('label', 50).notNullable();
    table.integer('price_inr').notNullable();
    table.integer('listing_limit').nullable(); // NULL = unlimited
    table.jsonb('features').notNullable().defaultTo('[]');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.integer('sort_order').notNullable().defaultTo(0);
    table.timestamps(true, true);
  });

  await knex('plans').insert([
    {
      key: 'starter', label: 'Starter', price_inr: 4999, listing_limit: 15, sort_order: 1,
      features: JSON.stringify(['Up to 15 listings', 'Shared WhatsApp number', 'Basic analytics']),
    },
    {
      key: 'growth', label: 'Growth', price_inr: 9999, listing_limit: 60, sort_order: 2,
      features: JSON.stringify(['Up to 60 listings', 'Dedicated WhatsApp number', 'Plot boundary tracing', 'Priority support']),
    },
    {
      key: 'unlimited', label: 'Unlimited', price_inr: 19999, listing_limit: null, sort_order: 3,
      features: JSON.stringify(['Unlimited listings', 'Dedicated WhatsApp number', 'Full analytics + lead scoring', 'Priority support']),
    },
  ]);

  // ---- 4. Password reset tokens ------------------------------------------
  await knex.schema.createTable('password_reset_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('token_hash', 64).notNullable().unique();
    table.timestamp('expires_at').notNullable();
    table.timestamp('used_at').nullable();
    table.timestamps(true, true);

    table.index(['user_id'], 'idx_password_reset_user');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('password_reset_tokens');
  await knex.schema.dropTableIfExists('plans');

  await knex.schema.alterTable('tenants', (table) => {
    table.dropColumn('phone_number_id');
    table.dropColumn('stripe_subscription_id');
  });

  await knex.raw(`DROP POLICY IF EXISTS listings_tenant_isolation_select ON listings`);
  await knex.raw(`DROP POLICY IF EXISTS listings_tenant_isolation_write ON listings`);
  await knex.raw(`
    CREATE POLICY listings_tenant_isolation_select
      ON listings FOR SELECT
      USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
  `);
  await knex.raw(`
    CREATE POLICY listings_tenant_isolation_write
      ON listings FOR ALL
      USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
      WITH CHECK (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
  `);

  const STRICT_TABLES = ['users', 'tenant_configs', 'leads', 'whatsapp_threads'];
  for (const table of STRICT_TABLES) {
    await knex.raw(`DROP POLICY IF EXISTS ${table}_tenant_isolation_select ON ${table}`);
    await knex.raw(`DROP POLICY IF EXISTS ${table}_tenant_isolation_write ON ${table}`);
    await knex.raw(`
      CREATE POLICY ${table}_tenant_isolation_select ON ${table} FOR SELECT
        USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
    `);
    await knex.raw(`
      CREATE POLICY ${table}_tenant_isolation_write ON ${table} FOR ALL
        USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
        WITH CHECK (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
    `);
  }

  await knex.raw(`DROP FUNCTION IF EXISTS is_service_context()`);
};
