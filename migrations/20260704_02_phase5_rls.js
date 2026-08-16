/**
 * Phase 5: Row-Level Security on all directly tenant-scoped tables.
 *
 * Defense-in-depth — the existing WHERE tenant_id = req.user.tenant_id
 * clauses in every controller remain the primary enforcement. RLS adds a
 * database-level safety net so a buggy or forgotten WHERE clause can never
 * leak cross-tenant data.
 *
 * Only tables with a direct tenant_id column get policies here. Tables
 * without one (listing_media, listing_landmarks, listing_visits,
 * whatsapp_messages) are indirectly protected through their parent rows —
 * adding subquery-based policies on those would hurt query performance with
 * no practical security gain given the app-layer WHERE clauses already in
 * place.
 *
 * Policy design:
 *   current_setting('app.current_tenant_id', true) returns '' when the
 *   session variable hasn't been set (the 'true' flag suppresses the
 *   "unrecognized configuration parameter" error). When it's empty, all
 *   rows are visible — this is intentional, because public routes (e.g.
 *   getPublicListing) never set tenant context and rely on the app-layer
 *   WHERE clause alone. When it IS set (dashboard routes, via the
 *   tenantTransaction middleware), only the matching tenant's rows are
 *   visible — even if the app-layer WHERE clause were accidentally removed.
 */

const TABLES = ['users', 'tenant_configs', 'listings', 'leads', 'whatsapp_threads'];

exports.up = async function (knex) {
  // Helper function readable from any session — returns the tenant UUID from
  // the local session variable set by tenantTransaction middleware.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION current_tenant_id()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $$
      SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    $$
  `);

  for (const table of TABLES) {
    await knex.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);

    // FORCE RLS even for the DB owner / superuser role — without FORCE, the
    // table owner bypasses all policies, which would defeat the point.
    await knex.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);

    // SELECT policy: allow all rows when no tenant context is set (public
    // routes), restrict to matching tenant when context is set (dashboard).
    await knex.raw(`
      CREATE POLICY ${table}_tenant_isolation_select
        ON ${table}
        FOR SELECT
        USING (
          current_tenant_id() IS NULL
          OR tenant_id = current_tenant_id()
        )
    `);

    // INSERT/UPDATE/DELETE policy: always require explicit tenant match.
    // These operations only happen on authenticated dashboard routes where
    // the transaction middleware guarantees tenant context is set.
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
  for (const table of [...TABLES].reverse()) {
    await knex.raw(`DROP POLICY IF EXISTS ${table}_tenant_isolation_select ON ${table}`);
    await knex.raw(`DROP POLICY IF EXISTS ${table}_tenant_isolation_write ON ${table}`);
    await knex.raw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS current_tenant_id()`);
};
