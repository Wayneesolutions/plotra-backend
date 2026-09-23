#!/usr/bin/env node
/**
 * Import a locality seed file into Postgres, optionally geocoding centres with Google.
 *
 *   node scripts/importLocalities.js --file data/ludhiana_localities.json --geocode --dry-run
 *   node scripts/importLocalities.js --file data/ludhiana_localities.json --geocode
 *
 * --dry-run  : geocode + write review CSV only, no DB writes
 * --geocode  : fill center_lat/lng, radius, pincode from Google Geocoding API (GOOGLE_MAPS_API_KEY)
 *
 * Safety: rows already marked status='active' (human-verified) never get their coords overwritten.
 * Everything imported lands as status='needs_review'.
 */

const fs = require('fs');
const path = require('path');
const { normalize, slugify } = require('../src/services/locality/normalize');
const { haversineM } = require('../src/services/locality/geoCheck');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const DEFAULT_RADIUS = { sector: 700, area: 1200, industrial: 2000, town: 3000, road: 3000 };
const MAX_FROM_CITY_M = 30000;

async function geocode(name, city, cityCenter) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', `${name}, ${city}, Punjab, India`);
  url.searchParams.set('components', 'country:IN');
  url.searchParams.set('bounds', `${cityCenter.lat - 0.15},${cityCenter.lng - 0.2}|${cityCenter.lat + 0.15},${cityCenter.lng + 0.2}`);
  url.searchParams.set('key', key);
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results.length) return { ok: false, why: data.status };

  const r = data.results[0];
  const types = r.types || [];
  // If Google just returned "Ludhiana" itself, it didn't find the locality
  if (types.includes('locality') && !types.some((t) => t.startsWith('sublocality') || t === 'neighborhood')) {
    return { ok: false, why: 'resolved_to_city_only' };
  }
  const { lat, lng } = r.geometry.location;
  const dist = haversineM(lat, lng, cityCenter.lat, cityCenter.lng);
  if (dist > MAX_FROM_CITY_M) return { ok: false, why: `too_far_${Math.round(dist / 1000)}km` };

  let radius = null;
  const vp = r.geometry.bounds || r.geometry.viewport;
  if (vp) {
    const diag = haversineM(vp.northeast.lat, vp.northeast.lng, vp.southwest.lat, vp.southwest.lng);
    radius = Math.round(Math.min(4000, Math.max(400, diag / 2)));
  }
  const pc = (r.address_components || []).find((c) => c.types.includes('postal_code'));
  return {
    ok: true,
    lat, lng, radius,
    pincode: pc ? pc.long_name : null,
    googleName: r.formatted_address,
    googleTypes: types.join('|'),
    locationType: r.geometry.location_type,
  };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const file = opt('--file');
  if (!file) throw new Error('--file is required');
  const seed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const { city, cityCenter } = seed;
  const dryRun = flag('--dry-run');

  const rows = [];
  for (const l of seed.localities) {
    const row = {
      city,
      name: l.name,
      slug: slugify(l.name),
      kind: l.kind || 'area',
      parent: l.parent || null,
      aliases: l.aliases || [],
      pincode: l.pincode || null,
      center_lat: l.lat ?? null,
      center_lng: l.lng ?? null,
      radius_m: l.radius_m || DEFAULT_RADIUS[l.kind] || 1000,
      geocode_note: '',
    };
    if (flag('--geocode') && row.center_lat == null) {
      try {
        const g = await geocode(l.name, city, cityCenter);
        if (g.ok) {
          row.center_lat = g.lat;
          row.center_lng = g.lng;
          // roads are long corridors; Google's viewport for a road is misleading, keep default
          if (g.radius && row.kind !== 'road') row.radius_m = g.radius;
          row.pincode = row.pincode || g.pincode;
          row.geocode_note = `${g.locationType} | ${g.googleTypes} | ${g.googleName}`;
        } else {
          row.geocode_note = `FAILED: ${g.why}`;
        }
      } catch (e) {
        row.geocode_note = `ERROR: ${e.message}`;
      }
      await new Promise((r) => setTimeout(r, 120)); // stay well under QPS limits
    }
    rows.push(row);
    process.stdout.write(`${row.center_lat ? '✓' : '✗'} ${row.name}  ${row.geocode_note}\n`);
  }

  // Review CSV for the team
  const csvPath = path.resolve(`locality_review_${slugify(city)}.csv`);
  const header = ['name', 'kind', 'parent', 'pincode', 'center_lat', 'center_lng', 'radius_m', 'maps_link', 'geocode_note', 'aliases'];
  const lines = [header.join(',')].concat(
    rows.map((r) =>
      [
        r.name, r.kind, r.parent, r.pincode, r.center_lat, r.center_lng, r.radius_m,
        r.center_lat ? `https://www.google.com/maps?q=${r.center_lat},${r.center_lng}` : '',
        r.geocode_note, r.aliases.join(' ; '),
      ].map(csvCell).join(',')
    )
  );
  fs.writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nReview sheet: ${csvPath}`);
  const failed = rows.filter((r) => r.center_lat == null).length;
  console.log(`${rows.length - failed} geocoded, ${failed} need manual coordinates`);

  if (dryRun) return;

  const knex = require('knex')(require(path.resolve('knexfile.js'))[process.env.NODE_ENV || 'development']);
  try {
    const idBySlug = {};
    for (const r of rows) {
      const existing = await knex('localities').where({ city, slug: r.slug }).first();
      let id;
      if (existing) {
        id = existing.id;
        const patch = { kind: r.kind, updated_at: knex.fn.now() };
        if (existing.status !== 'active') {
          Object.assign(patch, { center_lat: r.center_lat, center_lng: r.center_lng, radius_m: r.radius_m, pincode: r.pincode });
        }
        await knex('localities').where({ id }).update(patch);
      } else {
        [{ id }] = await knex('localities')
          .insert({
            city, name: r.name, slug: r.slug, kind: r.kind, pincode: r.pincode,
            center_lat: r.center_lat, center_lng: r.center_lng, radius_m: r.radius_m,
            status: 'needs_review', source: 'seed',
          })
          .returning('id');
      }
      idBySlug[r.slug] = id;

      const aliasRows = [...new Set([r.name, ...r.aliases])]
        .map((a) => ({ locality_id: id, alias: a, alias_normalized: normalize(a), source: 'seed' }))
        .filter((a) => a.alias_normalized);
      if (aliasRows.length) {
        await knex('locality_aliases').insert(aliasRows).onConflict(['locality_id', 'alias_normalized']).ignore();
      }
    }
    for (const r of rows.filter((x) => x.parent)) {
      const parentId = idBySlug[slugify(r.parent)];
      if (parentId) await knex('localities').where({ id: idBySlug[r.slug] }).update({ parent_id: parentId });
    }
    console.log(`Imported ${rows.length} localities for ${city}`);
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
