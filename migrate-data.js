/**
 * One-time data migration: old Neon DB → new Neon DB
 * Run: node migrate-data.js
 * Safe to re-run — uses ON CONFLICT DO NOTHING
 */

const { Client } = require('pg');

const OLD_DB = 'postgresql://neondb_owner:npg_epiyD4XKYjZ7@ep-muddy-glitter-at1ezhpn.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const NEW_DB = 'postgresql://neondb_owner:npg_sk3GSKNQy4Dq@ep-weathered-boat-aw5tgtnt.c-12.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

function topologicalSort(tables, fkDeps) {
  const graph = {};
  const inDegree = {};

  for (const t of tables) {
    graph[t] = [];
    inDegree[t] = 0;
  }

  for (const { child, parent } of fkDeps) {
    if (child === parent) continue;
    if (!graph[parent] || !graph[child]) continue;
    graph[parent].push(child);
    inDegree[child]++;
  }

  const queue = tables.filter(t => inDegree[t] === 0);
  const order = [];

  while (queue.length > 0) {
    const node = queue.shift();
    order.push(node);
    for (const dep of graph[node]) {
      inDegree[dep]--;
      if (inDegree[dep] === 0) queue.push(dep);
    }
  }

  // Append any remaining (circular refs, shouldn't happen here)
  for (const t of tables) {
    if (!order.includes(t)) order.push(t);
  }

  return order;
}

async function migrate() {
  const oldClient = new Client({ connectionString: OLD_DB, ssl: { rejectUnauthorized: false } });
  const newClient = new Client({ connectionString: NEW_DB, ssl: { rejectUnauthorized: false } });

  await oldClient.connect();
  console.log('Connected to OLD database');

  await newClient.connect();
  console.log('Connected to NEW database');

  // Get all user tables (skip knex internals)
  const { rows: tableRows } = await oldClient.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT IN ('knex_migrations', 'knex_migrations_lock')
    ORDER BY tablename
  `);
  const tables = tableRows.map(r => r.tablename);
  console.log(`\nFound ${tables.length} tables:`, tables.join(', '));

  // Get FK dependencies for correct insert order
  const { rows: fkDeps } = await oldClient.query(`
    SELECT
      tc.table_name  AS child,
      ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `);

  const insertOrder = topologicalSort(tables, fkDeps);
  console.log(`\nInsertion order resolved: ${insertOrder.join(' → ')}\n`);

  // Disable FK + RLS checks on new DB so we can bulk-insert freely
  await newClient.query("SET session_replication_role = replica");

  let totalRows = 0;

  for (const table of insertOrder) {
    const { rows } = await oldClient.query(`SELECT * FROM "${table}"`);

    if (rows.length === 0) {
      console.log(`  ${table}: (empty, skipped)`);
      continue;
    }

    const cols = Object.keys(rows[0]);
    const colList = cols.map(c => `"${c}"`).join(', ');
    let inserted = 0;

    for (const row of rows) {
      const values = cols.map(c => row[c]);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      try {
        await newClient.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
        inserted++;
      } catch (err) {
        console.error(`  ERROR inserting into ${table}:`, err.message);
      }
    }

    console.log(`  ${table}: ${inserted}/${rows.length} rows copied`);
    totalRows += inserted;
  }

  // Re-enable FK checks
  await newClient.query("SET session_replication_role = DEFAULT");

  // Reset all sequences to the max of their column (so next INSERT gets correct IDs)
  const { rows: seqRows } = await newClient.query(`
    SELECT
      s.relname AS seq_name,
      a.attname AS col,
      t.relname AS tbl
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    JOIN pg_class t ON t.oid = d.refobjid
    WHERE s.relkind = 'S'
  `);

  for (const { seq_name, col, tbl } of seqRows) {
    try {
      await newClient.query(`SELECT setval('"${seq_name}"', COALESCE((SELECT MAX("${col}") FROM "${tbl}"), 1))`);
    } catch (_) {}
  }

  await oldClient.end();
  await newClient.end();

  console.log(`\nDone. ${totalRows} total rows migrated.`);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
