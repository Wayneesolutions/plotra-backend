/**
 * Cities — multi-city support layered on top of the Locality Master
 * (migration 20260922_01_locality_master.js). Every locality and every
 * unmatched-text row now belongs to a city; the matcher and admin API move
 * from a free-text `city` string to `city_id` (see localityMatcher.js /
 * adminLocalities.js). See "Plotra — Cities & Localities Super-Admin Spec"
 * (2026-09-22) for the full design.
 *
 * A city has its own Draft -> Live -> Disabled lifecycle: only a `live`
 * city is matched against real dealer listings (draft cities are testable
 * via the admin test box only), gated on a minimum percentage of its
 * localities being human-verified (`min_verified_pct`).
 *
 * `localities.city` (text) is intentionally KEPT for one more release
 * rather than dropped here — every row is backfilled with the matching
 * `city_id` below, but existing code/queries that still read the text
 * column keep working until a follow-up migration drops it.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('cities', (t) => {
    t.increments('id').primary();
    t.string('name', 80).notNullable();
    t.string('slug', 90).notNullable().unique();
    t.string('state', 80).notNullable();
    t.decimal('center_lat', 10, 7).notNullable();
    t.decimal('center_lng', 10, 7).notNullable();
    // Import/area-creation safety bound — a locality farther than this from
    // the city centre is rejected rather than silently accepted.
    t.integer('bounds_radius_km').notNullable().defaultTo(25);
    // draft = not yet matched against real listings; live = matching is
    // active; disabled = retired, no new matching.
    t.string('status', 20).notNullable().defaultTo('draft');
    // Go-live gate: percentage of this city's localities that must be
    // status='active' (human-verified) before go-live is allowed.
    t.integer('min_verified_pct').notNullable().defaultTo(80);
    t.timestamp('live_at');
    t.timestamps(true, true);
  });

  await knex.schema.alterTable('localities', (t) => {
    t.integer('city_id').references('id').inTable('cities').onDelete('RESTRICT');
  });
  await knex.schema.alterTable('locality_unmatched', (t) => {
    t.integer('city_id').references('id').inTable('cities').onDelete('RESTRICT');
  });
  if (await knex.schema.hasTable('tenants')) {
    await knex.schema.alterTable('tenants', (t) => {
      t.integer('city_id').references('id').inTable('cities').onDelete('SET NULL').index();
    });
  }

  // ---- Backfill ---------------------------------------------------------
  // 1. One `cities` row per distinct localities.city value (case-insensitive).
  //    Ludhiana gets the spec's known centre; any other pre-existing city
  //    text (none expected before this migration, since only the Ludhiana
  //    seed has ever been imported) falls back to the average centre of its
  //    own geocoded localities, so the migration stays correct rather than
  //    assuming Ludhiana is the only city that will ever exist.
  const distinctCities = await knex('localities').distinct('city').whereNotNull('city');
  const cityIdByName = new Map(); // lowercased city text -> new cities.id

  for (const { city } of distinctCities) {
    const key = city.trim().toLowerCase();
    if (cityIdByName.has(key)) continue;

    let center_lat, center_lng, state;
    if (key === 'ludhiana') {
      center_lat = 30.9010;
      center_lng = 75.8573;
      state = 'Punjab';
    } else {
      const avg = await knex('localities')
        .whereRaw('lower(city) = ?', [key])
        .whereNotNull('center_lat')
        .whereNotNull('center_lng')
        .avg({ center_lat: 'center_lat', center_lng: 'center_lng' })
        .first();
      center_lat = avg?.center_lat != null ? Number(avg.center_lat) : 0;
      center_lng = avg?.center_lng != null ? Number(avg.center_lng) : 0;
      state = 'Punjab'; // best-effort default; unknown cities need admin review either way
      console.warn(`[migration 20260923_01] City "${city}" has no known centre — backfilled from its localities' average (lat=${center_lat}, lng=${center_lng}). Review in the admin panel.`);
    }

    const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const [{ id }] = await knex('cities')
      .insert({ name: city.trim(), slug, state, center_lat, center_lng, status: 'draft' })
      .returning('id');
    cityIdByName.set(key, id);
  }

  // 2. Point localities / locality_unmatched at their city.
  for (const [key, cityId] of cityIdByName) {
    await knex('localities').whereRaw('lower(city) = ?', [key]).update({ city_id: cityId });
    await knex('locality_unmatched').whereRaw('lower(city) = ?', [key]).update({ city_id: cityId });
  }

  // 3. Map existing tenants to a city from their current operating_city,
  //    case-insensitively. Left null (and logged) when it doesn't match a
  //    city that exists yet — that tenant simply won't get locality
  //    matching until an admin sets one, same as any tenant onboarded
  //    before this feature existed.
  if (await knex.schema.hasTable('tenants') && await knex.schema.hasColumn('tenants', 'operating_city')) {
    const tenants = await knex('tenants').whereNotNull('operating_city').select('id', 'operating_city', 'business_name');
    const unmatched = [];
    for (const t of tenants) {
      const key = t.operating_city.trim().toLowerCase();
      const cityId = cityIdByName.get(key);
      if (cityId) {
        await knex('tenants').where({ id: t.id }).update({ city_id: cityId });
      } else {
        unmatched.push(`${t.business_name} (${t.id}): operating_city="${t.operating_city}"`);
      }
    }
    if (unmatched.length) {
      console.warn(`[migration 20260923_01] ${unmatched.length} tenant(s) left with no city_id (no matching city yet):\n  ${unmatched.join('\n  ')}`);
    }
  }

  // 4. Now that every row has a city_id, enforce it, and move the old
  //    (city, slug) / (city, normalized) uniqueness onto (city_id, ...).
  await knex.schema.alterTable('localities', (t) => {
    t.integer('city_id').notNullable().alter();
    t.dropUnique(['city', 'slug']);
    t.dropIndex(['city', 'status']);
    t.unique(['city_id', 'slug']);
    t.index(['city_id', 'status']);
  });
  await knex.schema.alterTable('locality_unmatched', (t) => {
    t.integer('city_id').notNullable().alter();
    t.dropUnique(['city', 'normalized']);
    t.unique(['city_id', 'normalized']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('locality_unmatched', (t) => {
    t.dropUnique(['city_id', 'normalized']);
    t.unique(['city', 'normalized']);
    t.dropColumn('city_id');
  });
  await knex.schema.alterTable('localities', (t) => {
    t.dropUnique(['city_id', 'slug']);
    t.dropIndex(['city_id', 'status']);
    t.unique(['city', 'slug']);
    t.index(['city', 'status']);
    t.dropColumn('city_id');
  });
  if (await knex.schema.hasTable('tenants') && await knex.schema.hasColumn('tenants', 'city_id')) {
    await knex.schema.alterTable('tenants', (t) => {
      t.dropColumn('city_id');
    });
  }
  await knex.schema.dropTableIfExists('cities');
};
