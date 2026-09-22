/**
 * Locality Master
 *  - localities            : one row per official area (Dugri Phase 2, Sarabha Nagar...)
 *  - locality_aliases      : every spelling / script / shorthand that maps to a locality
 *  - locality_unmatched    : texts the matcher couldn't resolve -> super-admin queue
 *  - listings.* columns    : which locality a listing belongs to + how it was matched
 */

exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  await knex.schema.createTable('localities', (t) => {
    t.increments('id').primary();
    t.string('city', 80).notNullable();
    t.string('name', 150).notNullable();            // official display name
    t.string('slug', 170).notNullable();            // dugri-phase-2
    t.string('kind', 20).notNullable().defaultTo('area'); // area | sector | road | town | industrial
    t.integer('parent_id').references('id').inTable('localities').onDelete('SET NULL');
    t.string('pincode', 6);
    t.decimal('center_lat', 10, 7);
    t.decimal('center_lng', 10, 7);
    t.integer('radius_m').notNullable().defaultTo(1000);
    t.jsonb('boundary');                            // optional GeoJSON Polygon, [lng,lat] order
    // needs_review = name/coords not yet checked by a human; active = verified; disabled = hidden
    t.string('status', 20).notNullable().defaultTo('needs_review');
    t.string('source', 30).notNullable().defaultTo('seed');
    t.timestamps(true, true);
    t.unique(['city', 'slug']);
    t.index(['city', 'status']);
  });

  await knex.schema.createTable('locality_aliases', (t) => {
    t.increments('id').primary();
    t.integer('locality_id').notNullable().references('id').inTable('localities').onDelete('CASCADE');
    t.string('alias', 200).notNullable();
    t.string('alias_normalized', 200).notNullable();
    t.string('source', 20).notNullable().defaultTo('manual'); // seed | manual | learned
    t.timestamps(true, true);
    t.unique(['locality_id', 'alias_normalized']);
  });
  await knex.raw(
    'CREATE INDEX locality_aliases_norm_trgm ON locality_aliases USING gin (alias_normalized gin_trgm_ops)'
  );

  await knex.schema.createTable('locality_unmatched', (t) => {
    t.increments('id').primary();
    t.string('city', 80).notNullable();
    t.text('raw_text').notNullable();
    t.string('normalized', 300).notNullable();
    t.integer('listing_id');
    t.integer('suggested_locality_id').references('id').inTable('localities').onDelete('SET NULL');
    t.decimal('suggested_confidence', 4, 3);
    t.integer('seen_count').notNullable().defaultTo(1);
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | resolved | ignored
    t.integer('resolved_locality_id').references('id').inTable('localities').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['city', 'normalized']);
    t.index(['status']);
  });

  if (await knex.schema.hasTable('listings')) {
    const add = async (col, fn) => {
      if (!(await knex.schema.hasColumn('listings', col))) {
        await knex.schema.alterTable('listings', fn);
      }
    };
    await add('locality_id', (t) =>
      t.integer('locality_id').references('id').inTable('localities').onDelete('SET NULL').index()
    );
    await add('locality_match_method', (t) => t.string('locality_match_method', 20)); // exact|contains|fuzzy|llm|admin|dealer
    await add('locality_match_confidence', (t) => t.decimal('locality_match_confidence', 4, 3));
    await add('locality_pin_verdict', (t) => t.string('locality_pin_verdict', 20)); // inside|near|outside|unknown
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('listings')) {
    for (const col of ['locality_pin_verdict', 'locality_match_confidence', 'locality_match_method', 'locality_id']) {
      if (await knex.schema.hasColumn('listings', col)) {
        await knex.schema.alterTable('listings', (t) => t.dropColumn(col));
      }
    }
  }
  await knex.schema.dropTableIfExists('locality_unmatched');
  await knex.schema.dropTableIfExists('locality_aliases');
  await knex.schema.dropTableIfExists('localities');
};
