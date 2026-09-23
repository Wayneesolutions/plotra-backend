#!/usr/bin/env node
/**
 * Import a locality seed file into a city, optionally geocoding centres
 * with Google. Thin CLI wrapper around services/locality/importService.js
 * — the same import logic the admin CSV-upload API uses.
 *
 *   node scripts/importLocalities.js --city-id 1 --file data/ludhiana_localities.json --geocode --dry-run
 *   node scripts/importLocalities.js --city-id 1 --file data/ludhiana_localities.json --geocode
 *
 * --city-id  : required. The `cities.id` row to import into (create it via
 *              the admin API / POST /api/v1/admin/cities first).
 * --dry-run  : write a review CSV only, no DB writes
 * --geocode  : fill center_lat/lng, radius, pincode from Google Geocoding API
 *              (GOOGLE_MAPS_API_KEY) for rows the JSON doesn't already have
 *              coordinates for. Centre/bounds come from the city row itself,
 *              not the JSON file's (now-unused) top-level cityCenter.
 *
 * Safety: rows already marked status='active' (human-verified) never get
 * their coordinates overwritten — see importService.js.
 */

const fs = require('fs');
const path = require('path');
const { importLocalities, CSV_COLUMNS } = require('../src/services/locality/importService');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** seeds/*.json's { localities: [{ name, kind, parent, aliases, pincode, lat, lng, radius_m }] } -> CSV text. */
function seedJsonToCsv(seed) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const l of seed.localities) {
    lines.push([
      l.name, l.kind || 'area', l.parent || '', l.pincode || '',
      l.lat ?? '', l.lng ?? '', l.radius_m ?? '', (l.aliases || []).join(';'),
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

async function main() {
  const cityId = opt('--city-id');
  const file = opt('--file');
  if (!cityId) throw new Error('--city-id is required (create the city first via POST /api/v1/admin/cities)');
  if (!file) throw new Error('--file is required');
  const dryRun = flag('--dry-run');
  const geocode = flag('--geocode');

  const seed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const csvText = seedJsonToCsv(seed);

  const knexConfig = require(path.resolve('knexfile.js'));
  const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);

  try {
    const { city, rows, counts } = await importLocalities({
      knex,
      cityId: Number(cityId),
      csvText,
      geocode,
      apiKey: process.env.GOOGLE_MAPS_API_KEY,
      write: !dryRun,
    });

    for (const r of rows) {
      const mark = r.errors.length ? '✗' : (r.input.center_lat != null ? '✓' : '·');
      const note = r.errors.length ? `SKIPPED: ${r.errors.join('; ')}` : (r.note || r.action);
      process.stdout.write(`${mark} ${r.input.name}  ${note}\n`);
    }

    const header = ['name', 'kind', 'parent', 'pincode', 'center_lat', 'center_lng', 'radius_m', 'maps_link', 'action_or_error', 'aliases'];
    const csvLines = [header.join(',')].concat(
      rows.map((r) => [
        r.input.name, r.input.kind, r.input.parent, r.input.pincode,
        r.input.center_lat, r.input.center_lng, r.input.radius_m,
        r.input.center_lat ? `https://www.google.com/maps?q=${r.input.center_lat},${r.input.center_lng}` : '',
        r.errors.length ? `FAILED: ${r.errors.join('; ')}` : r.action,
        r.input.aliases.join(' ; '),
      ].map(csvCell).join(','))
    );
    const csvPath = path.resolve(`locality_review_${city.slug}.csv`);
    fs.writeFileSync(csvPath, csvLines.join('\n'));
    console.log(`\nReview sheet: ${csvPath}`);
    console.log(`${city.name}: ${counts.create} to create, ${counts.update} to update, ${counts.skip} skipped (errors).`);
    if (dryRun) console.log('(dry run — nothing written to the database)');
    else console.log(`Imported into city_id=${cityId}.`);
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
