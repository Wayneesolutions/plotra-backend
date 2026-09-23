/**
 * Shared locality bulk-import logic — used by both the CLI seed script
 * (scripts/importLocalities.js, --city-id) and the admin CSV upload API
 * (POST /cities/:cityId/localities/import[/preview] in adminLocalities.js).
 *
 * CSV columns (aliases separated by ';', matching the review-CSV the CLI
 * script has always written): name, kind, parent, pincode, center_lat,
 * center_lng, radius_m, aliases
 *
 * Two entry points:
 *   previewImport()  - parses + validates, never touches the DB
 *   runImport()      - the same parse/validate, then actually writes
 *
 * Safety rules (see the Cities & Localities spec's edge-case table):
 *   - a locality whose centre is farther than the city's bounds_radius_km
 *     from the city centre is rejected, not silently imported
 *   - radius must be 200-5000m; coordinates must fall inside India's
 *     rough bounding box (lat 6-37, lng 68-98)
 *   - a row that already exists as status='active' (human-verified) never
 *     has its coordinates/radius overwritten by an import
 *   - capped at 2000 rows per file
 */

const { normalize, slugify } = require('./normalize');
const { haversineM } = require('./geoCheck');

const DEFAULT_RADIUS = { sector: 700, area: 1200, industrial: 2000, town: 3000, road: 3000 };
const MAX_ROWS = 2000;
const MIN_RADIUS_M = 200;
const MAX_RADIUS_M = 5000;
const INDIA_LAT = [6, 37];
const INDIA_LNG = [68, 98];
const CSV_COLUMNS = ['name', 'kind', 'parent', 'pincode', 'center_lat', 'center_lng', 'radius_m', 'aliases'];

/** Minimal RFC4180-ish CSV parser: quoted fields, "" escaping, CRLF/LF rows. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] && r[0].trim() !== ''));
}

/** Raw CSV rows -> locality input objects, matched against the CSV_COLUMNS header (order-independent). */
function csvRowsToInputs(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(CSV_COLUMNS.map((c) => [c, header.indexOf(c)]));

  return rows.slice(1).map((cols) => {
    const get = (col) => (idx[col] >= 0 ? (cols[idx[col]] || '').trim() : '');
    const lat = get('center_lat');
    const lng = get('center_lng');
    const radius = get('radius_m');
    return {
      name: get('name'),
      kind: get('kind') || 'area',
      parent: get('parent') || null,
      pincode: get('pincode') || null,
      center_lat: lat === '' ? null : Number(lat),
      center_lng: lng === '' ? null : Number(lng),
      radius_m: radius === '' ? null : Number(radius),
      aliases: get('aliases') ? get('aliases').split(';').map((a) => a.trim()).filter(Boolean) : [],
    };
  });
}

/**
 * Validates one row against city bounds + the fixed rules above.
 * @returns {string[]} error messages; empty = row is valid
 */
function validateRow(input, city) {
  const errors = [];
  if (!input.name) errors.push('name is required');

  const hasCoords = input.center_lat != null && input.center_lng != null;
  if (hasCoords) {
    if (Number.isNaN(input.center_lat) || Number.isNaN(input.center_lng)) {
      errors.push('center_lat/center_lng must be numbers');
    } else {
      if (input.center_lat < INDIA_LAT[0] || input.center_lat > INDIA_LAT[1]) errors.push(`center_lat out of range (${INDIA_LAT[0]}-${INDIA_LAT[1]})`);
      if (input.center_lng < INDIA_LNG[0] || input.center_lng > INDIA_LNG[1]) errors.push(`center_lng out of range (${INDIA_LNG[0]}-${INDIA_LNG[1]})`);
      if (city && city.center_lat != null && city.center_lng != null && !errors.length) {
        const distKm = haversineM(input.center_lat, input.center_lng, Number(city.center_lat), Number(city.center_lng)) / 1000;
        const boundsKm = city.bounds_radius_km || 25;
        if (distKm > boundsKm) errors.push(`centre is ${Math.round(distKm)}km from ${city.name || 'the city'} centre (max ${boundsKm}km)`);
      }
    }
  }
  if (input.radius_m != null) {
    if (Number.isNaN(input.radius_m)) errors.push('radius_m must be a number');
    else if (input.radius_m < MIN_RADIUS_M || input.radius_m > MAX_RADIUS_M) errors.push(`radius_m must be ${MIN_RADIUS_M}-${MAX_RADIUS_M}`);
  }
  return errors;
}

/** Shared row-classification: what would writing this row do? Never touches the DB. */
async function planRow(knex, cityId, input, existingBySlug) {
  const errors = validateRow(input, existingBySlug.__city);
  if (errors.length) return { input, action: 'skip', errors };

  const slug = slugify(input.name);
  const existing = existingBySlug.get(slug);
  if (!existing) return { input, action: 'create', errors: [], slug };
  if (existing.status === 'active') {
    return { input, action: 'update', errors: [], slug, note: 'verified — coordinates will NOT be overwritten' };
  }
  return { input, action: 'update', errors: [], slug };
}

async function loadExistingBySlug(knex, cityId) {
  const rows = await knex('localities').where({ city_id: cityId }).select('id', 'slug', 'status');
  const map = new Map(rows.map((r) => [r.slug, r]));
  return map;
}

/** Google Geocoding for a locality centre — same logic the CLI script has always used. */
async function geocodeLocality(name, city, apiKey) {
  if (!apiKey) return { ok: false, why: 'no_api_key' };
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', `${name}, ${city.name}, ${city.state || ''}, India`);
  url.searchParams.set('components', 'country:IN');
  url.searchParams.set(
    'bounds',
    `${city.center_lat - 0.15},${city.center_lng - 0.2}|${Number(city.center_lat) + 0.15},${Number(city.center_lng) + 0.2}`
  );
  url.searchParams.set('key', apiKey);
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results.length) return { ok: false, why: data.status };

  const r = data.results[0];
  const types = r.types || [];
  if (types.includes('locality') && !types.some((t) => t.startsWith('sublocality') || t === 'neighborhood')) {
    return { ok: false, why: 'resolved_to_city_only' };
  }
  const { lat, lng } = r.geometry.location;
  const dist = haversineM(lat, lng, Number(city.center_lat), Number(city.center_lng)) / 1000;
  if (dist > (city.bounds_radius_km || 25)) return { ok: false, why: `too_far_${Math.round(dist)}km` };

  let radius = null;
  const vp = r.geometry.bounds || r.geometry.viewport;
  if (vp) {
    const diag = haversineM(vp.northeast.lat, vp.northeast.lng, vp.southwest.lat, vp.southwest.lng);
    radius = Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, diag / 2)));
  }
  const pc = (r.address_components || []).find((c) => c.types.includes('postal_code'));
  return { ok: true, lat, lng, radius, pincode: pc ? pc.long_name : null, googleName: r.formatted_address };
}

/**
 * @param {object} p
 * @param {import('knex').Knex} p.knex
 * @param {number} p.cityId
 * @param {string} p.csvText
 * @param {boolean} [p.geocode] - fill missing center_lat/lng via Google
 * @param {string} [p.apiKey] - GOOGLE_MAPS_API_KEY
 * @param {boolean} [p.write] - false = preview only (default true = actually write)
 */
async function importLocalities({ knex, cityId, csvText, geocode = false, apiKey = null, write = true }) {
  const city = await knex('cities').where({ id: cityId }).first();
  if (!city) throw new Error('city not found');

  const rawRows = parseCsv(csvText);
  const inputs = csvRowsToInputs(rawRows);
  if (inputs.length > MAX_ROWS) throw new Error(`CSV has ${inputs.length} rows, max is ${MAX_ROWS}`);

  const existingBySlug = await loadExistingBySlug(knex, cityId);
  existingBySlug.__city = city;

  const plans = [];
  for (const input of inputs) {
    if (geocode && input.center_lat == null && input.name) {
      const g = await geocodeLocality(input.name, city, apiKey);
      if (g.ok) {
        input.center_lat = g.lat;
        input.center_lng = g.lng;
        if (g.radius && input.kind !== 'road') input.radius_m = input.radius_m || g.radius;
        input.pincode = input.pincode || g.pincode;
      }
      await new Promise((r) => setTimeout(r, 120)); // stay well under Google QPS limits
    }
    if (input.radius_m == null) input.radius_m = DEFAULT_RADIUS[input.kind] || 1000;
    plans.push(await planRow(knex, cityId, input, existingBySlug));
  }

  if (!write) {
    return { city, rows: plans, counts: summarize(plans) };
  }

  const idBySlug = {};
  for (const plan of plans) {
    if (plan.errors.length) continue;
    const { input, slug } = plan;
    const existing = existingBySlug.get(slug);
    let id;
    if (existing) {
      id = existing.id;
      const patch = { kind: input.kind, updated_at: knex.fn.now() };
      if (existing.status !== 'active') {
        Object.assign(patch, {
          center_lat: input.center_lat, center_lng: input.center_lng,
          radius_m: input.radius_m, pincode: input.pincode,
        });
      }
      await knex('localities').where({ id }).update(patch);
    } else {
      [{ id }] = await knex('localities')
        .insert({
          city_id: cityId, name: input.name, slug, kind: input.kind, pincode: input.pincode,
          center_lat: input.center_lat, center_lng: input.center_lng, radius_m: input.radius_m,
          status: 'needs_review', source: 'seed',
        })
        .returning('id');
    }
    idBySlug[slug] = id;

    const aliasRows = [...new Set([input.name, ...input.aliases])]
      .map((a) => ({ locality_id: id, alias: a, alias_normalized: normalize(a), source: 'seed' }))
      .filter((a) => a.alias_normalized);
    if (aliasRows.length) {
      await knex('locality_aliases').insert(aliasRows).onConflict(['locality_id', 'alias_normalized']).ignore();
    }
  }
  for (const plan of plans) {
    if (plan.errors.length || !plan.input.parent) continue;
    const parentId = idBySlug[slugify(plan.input.parent)];
    if (parentId) await knex('localities').where({ id: idBySlug[plan.slug] }).update({ parent_id: parentId });
  }

  return { city, rows: plans, counts: summarize(plans) };
}

function summarize(plans) {
  return {
    total: plans.length,
    create: plans.filter((p) => p.action === 'create' && !p.errors.length).length,
    update: plans.filter((p) => p.action === 'update' && !p.errors.length).length,
    skip: plans.filter((p) => p.errors.length).length,
  };
}

module.exports = {
  parseCsv, csvRowsToInputs, validateRow, geocodeLocality, importLocalities,
  CSV_COLUMNS, MAX_ROWS, MIN_RADIUS_M, MAX_RADIUS_M, INDIA_LAT, INDIA_LNG,
};
