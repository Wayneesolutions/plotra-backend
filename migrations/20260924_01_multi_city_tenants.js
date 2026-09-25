/**
 * Multi-city tenants + city-wise tenant codes + agent cities.
 *
 * - cities.code        short city code used in tenant codes (Ludhiana = LDH).
 * - cities.tenant_seq  per-city counter behind LDH-001, LDH-002, ...
 * - tenant_cities      a tenant can operate in several cities. Each
 *                      (tenant, city) pair gets its own permanent code
 *                      (LDH-002, ASR-001). One row is the primary city;
 *                      tenants.city_id keeps mirroring the primary so
 *                      existing code that reads it keeps working. Removing
 *                      a city only deactivates the row, so the code comes
 *                      back unchanged if the city is added again.
 * - user_cities        optional per-agent cities (subset of the tenant's
 *                      active cities). An agent with none falls back to all
 *                      of the tenant's cities in geoEnrichmentWorker.js.
 * - tenant_requests.city_ids  cities picked on the public Request Access form.
 * - locality_unmatched.listing_id  was integer, listings.id is a uuid, so
 *                      every unmatched-queue insert failed. No valid rows
 *                      could have been stored, so the column is reset.
 */

function suggestCode(name) {
  const letters = String(name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return 'CTY';
  // First letter, then consonants, then vowels if still short:
  // Ludhiana -> LDH, Amritsar -> AMR, Una -> UNA.
  const rest = letters.slice(1).split('');
  const picked = [letters[0], ...rest.filter((ch) => !'AEIOU'.includes(ch)), ...rest.filter((ch) => 'AEIOU'.includes(ch))];
  return picked.join('').slice(0, 3).padEnd(3, 'X');
}


exports.up = async function up(knex) {
  await knex.schema.alterTable('cities', (t) => {
    t.string('code', 4).unique();
    t.integer('tenant_seq').notNullable().defaultTo(0);
  });

  // Fix empty city slugs left by the locality slugify() (it strips city
  // names like "ludhiana" as noise) — see adminLocalities.js citySlug().
  const blankSlugs = await knex('cities').where('slug', '').orWhereNull('slug').select('id', 'name');
  for (const c of blankSlugs) {
    const slug = String(c.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `city-${c.id}`;
    await knex('cities').where({ id: c.id }).update({ slug });
  }

  const known = { ludhiana: 'LDH', amritsar: 'ASR', jalandhar: 'JAL', mohali: 'MOH', chandigarh: 'CHD', patiala: 'PTA', bathinda: 'BTI' };
  const used = new Set();
  const cities = await knex('cities').select('id', 'name').orderBy('id');
  for (const c of cities) {
    let code = known[String(c.name).trim().toLowerCase()] || suggestCode(c.name);
    let n = 1;
    while (used.has(code)) code = `${code.slice(0, 2)}${n++}`;
    used.add(code);
    await knex('cities').where({ id: c.id }).update({ code });
  }

  await knex.schema.createTable('tenant_cities', (t) => {
    t.increments('id').primary();
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('city_id').notNullable().references('id').inTable('cities').onDelete('RESTRICT');
    t.string('code', 16).notNullable().unique();
    t.boolean('is_primary').notNullable().defaultTo(false);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['tenant_id', 'city_id']);
    t.index(['city_id']);
  });
  await knex.raw(`
    CREATE UNIQUE INDEX tenant_cities_one_primary
      ON tenant_cities (tenant_id) WHERE is_primary AND active
  `);

  // Backfill: every tenant already linked to a city gets it as its primary
  // city, numbered per city in joining order (oldest tenant = 001).
  const linked = await knex('tenants').whereNotNull('city_id').select('id', 'city_id').orderBy('created_at', 'asc');
  for (const tn of linked) {
    const [{ tenant_seq: seq, code }] = await knex('cities')
      .where({ id: tn.city_id })
      .increment('tenant_seq', 1)
      .returning(['tenant_seq', 'code']);
    await knex('tenant_cities').insert({
      tenant_id: tn.id,
      city_id: tn.city_id,
      code: `${code}-${String(seq).padStart(3, '0')}`,
      is_primary: true,
      active: true,
    });
  }

  await knex.schema.createTable('user_cities', (t) => {
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('city_id').notNullable().references('id').inTable('cities').onDelete('CASCADE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['user_id', 'city_id']);
  });

  await knex.schema.alterTable('tenant_requests', (t) => {
    t.specificType('city_ids', 'integer[]');
  });

  await knex.raw(`
    ALTER TABLE locality_unmatched
      ALTER COLUMN listing_id TYPE uuid USING NULL
  `);
  await knex.raw(`
    ALTER TABLE locality_unmatched
      ADD CONSTRAINT locality_unmatched_listing_fk
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE locality_unmatched DROP CONSTRAINT IF EXISTS locality_unmatched_listing_fk');
  await knex.raw('ALTER TABLE locality_unmatched ALTER COLUMN listing_id TYPE integer USING NULL');
  await knex.schema.alterTable('tenant_requests', (t) => t.dropColumn('city_ids'));
  await knex.schema.dropTableIfExists('user_cities');
  await knex.schema.dropTableIfExists('tenant_cities');
  await knex.schema.alterTable('cities', (t) => {
    t.dropColumn('tenant_seq');
    t.dropColumn('code');
  });
};
