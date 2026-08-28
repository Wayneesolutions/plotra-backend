/**
 * Self-learning location cache. Every listing's location is either (a)
 * manually pin-corrected by a dealer, or (b) implicitly confirmed when a
 * dealer approves a listing without touching the pin (they see the
 * satellite map in the preview link before replying "yes" — see
 * agentIntakeWorker.js's sendPreviewAndAwaitApproval). Both are a REAL
 * human confirming "this lat/lng is correct for this building/locality
 * name" — a signal Google's geocoder itself never gets. Right now that
 * signal is thrown away after each listing; this table keeps it, keyed by
 * normalized building/locality name, so the NEXT listing that names the
 * same building/society/locality (extremely common — the same mega-project
 * or colony gets listed by multiple dealers/agents over time) can skip
 * Google's geocoder entirely and use a coordinate a human already verified,
 * instead of re-rolling the dice on Google's prominence-ranked guess (the
 * exact mechanism that sent a Ludhiana listing to a Kolkata mall).
 *
 * Scoped per-tenant (not global) deliberately for this first version: two
 * different agencies' dealers may use loose/informal names for the same
 * area that mean different things to each other's operating region, and a
 * bad cross-tenant match would be worse than no cache hit at all (falls
 * through to the normal Google geocode either way). A tenant-scoped cache
 * is safe by construction — revisit a global "verified" tier later once
 * there's evidence the same normalized key resolves consistently *across*
 * tenants in the same city.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('resolved_localities', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');

    // Normalized (lowercased, punctuation-stripped) building_name or
    // raw_address text this entry was learned from. key_type records which
    // one, since a building name and a general locality address are
    // different granularities and shouldn't collide in lookup.
    table.string('normalized_key', 255).notNullable();
    table.string('key_type', 20).notNullable(); // 'building_name' | 'raw_address'
    table.string('display_name', 255).notNullable(); // original (non-normalized) text, for admin/debug visibility

    table.decimal('lat', 10, 7).notNullable();
    table.decimal('lng', 10, 7).notNullable();
    table.text('formatted_address').nullable();

    // 'manual_pin_drag' (dealer explicitly dragged the pin — high trust) or
    // 'implicit_approval' (dealer approved the AI geocode as-is — medium
    // trust, still a real human eyeballing the map first). A later
    // manual_pin_drag always overwrites an implicit_approval entry for the
    // same key, never the other way around — see resolvedLocalityService.js.
    table.string('source', 20).notNullable();

    // Incremented every time this exact key+coordinates gets reconfirmed by
    // another listing — this IS the "gets better over time" part: a key
    // that's been independently confirmed 5 times is far more trustworthy
    // than one confirmed once, useful once this cache is mature enough to
    // expose a confidence threshold in the geocode lookup.
    table.integer('confidence').notNullable().defaultTo(1);

    table.timestamp('last_confirmed_at').defaultTo(knex.fn.now());
    table.timestamps(true, true);

    // One entry per tenant+key+granularity — a later write updates
    // (coordinates + confidence + last_confirmed_at), never duplicates.
    table.unique(['tenant_id', 'normalized_key', 'key_type']);
    table.index(['tenant_id', 'normalized_key', 'key_type'], 'idx_resolved_localities_lookup');
  });

  // Lets the approval step (agentIntakeController.js) tell "dealer dragged
  // the pin" apart from "dealer approved the AI geocode untouched" — only
  // the untouched case should record an 'implicit_approval' cache entry;
  // a listing that WAS manually corrected already got its (higher-trust)
  // 'manual_pin_drag' cache entry at correction time, in
  // publicListingController.js, so recording it again at approval would
  // just be a harmless but redundant confirm — this flag lets us skip that
  // and log the right source either way, and is generally useful signal on
  // its own for anyone auditing geocode quality later.
  await knex.schema.alterTable('listings', (table) => {
    table.boolean('pin_manually_corrected').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('pin_manually_corrected');
  });
  await knex.schema.dropTableIfExists('resolved_localities');
};
