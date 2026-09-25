/**
 * Super-admin API for Cities & the Locality Master.
 *
 * Mounted under src/routes/admin.js, which already applies
 * authGuard + adminGuard (super_admin only) to everything registered on
 * that router — no separate guard needed here.
 *
 * cities / localities / locality_aliases / locality_unmatched have no
 * tenant_id column and no RLS policy (see migrations 20260922_01 and
 * 20260923_01), so a plain, dedicated knex connection (same pattern as the
 * worker files, e.g. geoEnrichmentWorker.js) is enough — no per-request
 * req.dbTrx needed, including for the listings/tenants joins below: Phase 5
 * RLS (20260704_02) only restricts rows once app.current_tenant_id is set,
 * which a connection like this one never does, so it sees every tenant's
 * rows exactly like the worker files already do.
 *
 * See "Plotra — Cities & Localities Super-Admin Spec" (2026-09-22) for the
 * full endpoint table this file implements.
 */

const express = require('express');
const multer = require('multer');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { normalize, slugify } = require('../services/locality/normalize');
const { haversineM } = require('../services/locality/geoCheck');
const { createLocalityMatcher } = require('../services/locality/localityMatcher');
const { importLocalities } = require('../services/locality/importService');
const { normalizeCityCode, suggestCityCode } = require('../services/tenantCityService');

const matcher = createLocalityMatcher({ knex });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const INDIA_LAT = [6, 37];
const INDIA_LNG = [68, 98];
const MIN_RADIUS_M = 200;
const MAX_RADIUS_M = 5000;

// City slugs must NOT go through locality slugify(): its normalize() step
// strips city names as noise ("ludhiana", "punjab"), which left Ludhiana's
// slug as an empty string.
function citySlug(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function err(code, message) {
  return { error: { code, message } };
}

function createLocalityAdminRouter() {
  const r = express.Router();

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
      console.error('[admin-cities-localities]', e);
      res.status(500).json(err('INTERNAL_ERROR', e.message));
    });

  // ---------------------------------------------------------------------
  // Cities
  // ---------------------------------------------------------------------

  async function cityStats(cityId) {
    const [locality_count, verified_count, unmatched_pending, listing_count] = await Promise.all([
      knex('localities').where({ city_id: cityId }).whereNot('status', 'disabled').count('id as c').first(),
      knex('localities').where({ city_id: cityId, status: 'active' }).count('id as c').first(),
      knex('locality_unmatched').where({ city_id: cityId, status: 'pending' }).count('id as c').first(),
      knex('listings as li').join('localities as l', 'l.id', 'li.locality_id').where('l.city_id', cityId).count('li.id as c').first(),
    ]);
    const total = Number(locality_count.c);
    const verified = Number(verified_count.c);
    return {
      locality_count: total,
      verified_count: verified,
      verified_pct: total ? Math.round((verified / total) * 1000) / 10 : 0,
      listing_count: Number(listing_count.c),
      unmatched_pending: Number(unmatched_pending.c),
    };
  }

  r.get('/cities', wrap(async (req, res) => {
    const qb = knex('cities').orderBy('name');
    if (req.query.status) qb.where('status', req.query.status);
    const cities = await qb;
    const withStats = await Promise.all(cities.map(async (c) => ({ ...c, ...(await cityStats(c.id)) })));
    res.json(withStats);
  }));

  r.post('/cities', wrap(async (req, res) => {
    const { name, state, center_lat, center_lng, bounds_radius_km, code: rawCode } = req.body;
    if (!name || !state || center_lat == null || center_lng == null) {
      return res.status(400).json(err('VALIDATION_ERROR', 'name, state, center_lat and center_lng are required'));
    }
    const lat = Number(center_lat), lng = Number(center_lng);
    if (lat < INDIA_LAT[0] || lat > INDIA_LAT[1] || lng < INDIA_LNG[0] || lng > INDIA_LNG[1]) {
      return res.status(400).json(err('OUT_OF_BOUNDS', `Coordinates must fall within India (lat ${INDIA_LAT.join('-')}, lng ${INDIA_LNG.join('-')})`));
    }
    const slug = citySlug(name);
    const existing = await knex('cities').where({ slug }).first();
    if (existing) return res.status(409).json(err('DUPLICATE_CITY', 'City already exists'));

    // City code for tenant codes (LDH-001). Suggested from the name when not given.
    const code = rawCode ? normalizeCityCode(rawCode) : suggestCityCode(name);
    if (!code) return res.status(400).json(err('INVALID_CITY_CODE', 'City code must be 2-4 letters, e.g. LDH'));
    if (await knex('cities').where({ code }).first()) {
      return res.status(409).json(err('DUPLICATE_CITY_CODE', `City code ${code} is already used by another city`));
    }

    const [{ id }] = await knex('cities')
      .insert({ name: name.trim(), slug, state: state.trim(), center_lat: lat, center_lng: lng, bounds_radius_km: bounds_radius_km || 25, status: 'draft', code })
      .returning('id');
    const city = await knex('cities').where({ id }).first();
    res.status(201).json({ ...city, ...(await cityStats(id)) });
  }));

  r.get('/cities/:id', wrap(async (req, res) => {
    const city = await knex('cities').where({ id: req.params.id }).first();
    if (!city) return res.status(404).json(err('NOT_FOUND', 'City not found'));
    res.json({ ...city, ...(await cityStats(city.id)) });
  }));

  r.patch('/cities/:id', wrap(async (req, res) => {
    const allowed = ['name', 'state', 'center_lat', 'center_lng', 'bounds_radius_km', 'min_verified_pct', 'code'];
    const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    // Changing a city code only affects tenant codes issued AFTER the change —
    // existing codes (LDH-002) are permanent by design.
    if (patch.code !== undefined) {
      patch.code = normalizeCityCode(patch.code);
      if (!patch.code) return res.status(400).json(err('INVALID_CITY_CODE', 'City code must be 2-4 letters, e.g. LDH'));
      const clash = await knex('cities').where({ code: patch.code }).whereNot('id', req.params.id).first();
      if (clash) return res.status(409).json(err('DUPLICATE_CITY_CODE', `City code ${patch.code} is already used by ${clash.name}`));
    }
    if (patch.center_lat != null || patch.center_lng != null) {
      const city = await knex('cities').where({ id: req.params.id }).first();
      if (!city) return res.status(404).json(err('NOT_FOUND', 'City not found'));
      const lat = patch.center_lat != null ? Number(patch.center_lat) : Number(city.center_lat);
      const lng = patch.center_lng != null ? Number(patch.center_lng) : Number(city.center_lng);
      if (lat < INDIA_LAT[0] || lat > INDIA_LAT[1] || lng < INDIA_LNG[0] || lng > INDIA_LNG[1]) {
        return res.status(400).json(err('OUT_OF_BOUNDS', `Coordinates must fall within India (lat ${INDIA_LAT.join('-')}, lng ${INDIA_LNG.join('-')})`));
      }
    }
    if (patch.name) patch.slug = citySlug(patch.name);
    patch.updated_at = knex.fn.now();
    const [row] = await knex('cities').where({ id: req.params.id }).update(patch).returning('*');
    if (!row) return res.status(404).json(err('NOT_FOUND', 'City not found'));
    matcher.invalidate(Number(req.params.id));
    res.json({ ...row, ...(await cityStats(row.id)) });
  }));

  r.post('/cities/:id/go-live', wrap(async (req, res) => {
    const city = await knex('cities').where({ id: req.params.id }).first();
    if (!city) return res.status(404).json(err('NOT_FOUND', 'City not found'));
    const stats = await cityStats(city.id);
    if (stats.verified_pct < city.min_verified_pct) {
      return res.status(409).json({
        error: { code: 'BELOW_VERIFICATION_GATE', message: `Only ${stats.verified_pct}% of areas are verified; ${city.min_verified_pct}% required.` },
        verified_pct: stats.verified_pct,
        required_pct: city.min_verified_pct,
      });
    }
    const [row] = await knex('cities').where({ id: city.id }).update({ status: 'live', live_at: knex.fn.now(), updated_at: knex.fn.now() }).returning('*');
    matcher.invalidate(city.id);
    res.json({ ...row, ...stats });
  }));

  r.post('/cities/:id/disable', wrap(async (req, res) => {
    const city = await knex('cities').where({ id: req.params.id }).first();
    if (!city) return res.status(404).json(err('NOT_FOUND', 'City not found'));
    if (req.query.force !== 'true') {
      const activeListings = await knex('listings as li')
        .join('localities as l', 'l.id', 'li.locality_id')
        .where('l.city_id', city.id).where('li.status', 'active')
        .count('li.id as c').first();
      if (Number(activeListings.c) > 0) {
        return res.status(409).json({
          error: { code: 'ACTIVE_LISTINGS_EXIST', message: `${activeListings.c} active listing(s) use localities in this city. Pass ?force=true to disable anyway.` },
          count: Number(activeListings.c),
        });
      }
    }
    const [row] = await knex('cities').where({ id: city.id }).update({ status: 'disabled', updated_at: knex.fn.now() }).returning('*');
    matcher.invalidate(city.id);
    res.json(row);
  }));

  // ---------------------------------------------------------------------
  // Localities (scoped to a city)
  // ---------------------------------------------------------------------

  r.get('/cities/:cityId/localities', wrap(async (req, res) => {
    const { status, kind, q } = req.query;
    const qb = knex('localities as l')
      .leftJoin('listings as li', 'li.locality_id', 'l.id')
      .leftJoin('localities as p', 'p.id', 'l.parent_id')
      .where('l.city_id', req.params.cityId)
      .groupBy('l.id', 'p.name')
      .select('l.*', 'p.name as parent_name', knex.raw('count(li.id)::int as listing_count'))
      .orderBy('l.name');
    if (status) qb.where('l.status', status);
    if (kind) qb.where('l.kind', kind);
    if (q) qb.whereILike('l.name', `%${q}%`);
    const rows = await qb;
    const aliases = rows.length
      ? await knex('locality_aliases').whereIn('locality_id', rows.map((x) => x.id)).select('id', 'locality_id', 'alias', 'source')
      : [];
    for (const row of rows) row.aliases = aliases.filter((a) => a.locality_id === row.id);
    res.json(rows);
  }));

  async function validateAreaGeo(cityId, center_lat, center_lng, radius_m) {
    if (radius_m != null && (radius_m < MIN_RADIUS_M || radius_m > MAX_RADIUS_M)) {
      return `radius_m must be ${MIN_RADIUS_M}-${MAX_RADIUS_M}`;
    }
    if (center_lat == null || center_lng == null) return null;
    if (center_lat < INDIA_LAT[0] || center_lat > INDIA_LAT[1] || center_lng < INDIA_LNG[0] || center_lng > INDIA_LNG[1]) {
      return `Coordinates must fall within India (lat ${INDIA_LAT.join('-')}, lng ${INDIA_LNG.join('-')})`;
    }
    const city = await knex('cities').where({ id: cityId }).first();
    if (!city) return 'city not found';
    const distKm = haversineM(center_lat, center_lng, Number(city.center_lat), Number(city.center_lng)) / 1000;
    const boundsKm = city.bounds_radius_km || 25;
    if (distKm > boundsKm) return `Area centre is ${Math.round(distKm)}km from ${city.name}'s centre (max ${boundsKm}km)`;
    return null;
  }

  /** No cycles: newParentId cannot be locality itself or any of its own descendants. */
  async function wouldCreateCycle(cityId, localityId, newParentId) {
    if (!newParentId) return false;
    const targetId = Number(localityId);
    if (Number(newParentId) === targetId) return true;
    const rows = await knex('localities').where({ city_id: cityId }).select('id', 'parent_id');
    // Normalize every id to Number — parent_id round-trips through
    // Postgres/knex as a number, but a caller-supplied newParentId may
    // arrive as a string from JSON, and Map lookups are type-strict.
    const byId = new Map(rows.map((r) => [Number(r.id), r.parent_id != null ? Number(r.parent_id) : null]));
    let cursor = Number(newParentId);
    const seen = new Set();
    while (cursor != null) {
      if (cursor === targetId) return true;
      if (seen.has(cursor)) return false; // already-broken data elsewhere; don't loop forever
      seen.add(cursor);
      cursor = byId.get(cursor);
    }
    return false;
  }

  r.post('/cities/:cityId/localities', wrap(async (req, res) => {
    const cityId = Number(req.params.cityId);
    const { name, kind = 'area', parent_id, pincode, center_lat, center_lng, radius_m = 1000, aliases = [] } = req.body;
    if (!name) return res.status(400).json(err('VALIDATION_ERROR', 'name required'));

    const geoErr = await validateAreaGeo(cityId, center_lat, center_lng, radius_m);
    if (geoErr) return res.status(400).json(err('OUT_OF_BOUNDS', geoErr));
    if (parent_id) {
      const parent = await knex('localities').where({ id: parent_id, city_id: cityId }).first();
      if (!parent) return res.status(400).json(err('INVALID_PARENT', 'Parent area must be in the same city'));
    }

    const slug = slugify(name);
    const dup = await knex('localities').where({ city_id: cityId, slug }).first();
    if (dup) return res.status(409).json({ error: { code: 'DUPLICATE_AREA', message: 'Area already exists in this city' }, existing_id: dup.id });

    const [{ id }] = await knex('localities')
      .insert({
        city_id: cityId, name, slug, kind, parent_id: parent_id || null, pincode: pincode || null,
        center_lat, center_lng, radius_m, status: center_lat != null ? 'active' : 'needs_review', source: 'admin',
      })
      .returning('id');
    const aliasRows = [...new Set([name, ...aliases])]
      .map((a) => ({ locality_id: id, alias: a, alias_normalized: normalize(a), source: 'manual' }))
      .filter((a) => a.alias_normalized);
    if (aliasRows.length) await knex('locality_aliases').insert(aliasRows).onConflict(['locality_id', 'alias_normalized']).ignore();
    matcher.invalidate(cityId);
    res.status(201).json({ id });
  }));

  // Edit / verify. Setting status:'active' = "I checked the pin on the map, it's right".
  r.patch('/localities/:id', wrap(async (req, res) => {
    const existing = await knex('localities').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json(err('NOT_FOUND', 'not found'));

    const allowed = ['name', 'kind', 'parent_id', 'pincode', 'center_lat', 'center_lng', 'radius_m', 'boundary', 'status'];
    const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    const geoErr = await validateAreaGeo(
      existing.city_id,
      patch.center_lat ?? existing.center_lat,
      patch.center_lng ?? existing.center_lng,
      patch.radius_m ?? existing.radius_m
    );
    if (geoErr) return res.status(400).json(err('OUT_OF_BOUNDS', geoErr));

    if (patch.parent_id) {
      const parent = await knex('localities').where({ id: patch.parent_id, city_id: existing.city_id }).first();
      if (!parent) return res.status(400).json(err('INVALID_PARENT', 'Parent area must be in the same city'));
      if (await wouldCreateCycle(existing.city_id, existing.id, patch.parent_id)) {
        return res.status(400).json(err('PARENT_CYCLE', 'An area cannot be its own ancestor'));
      }
    }

    if (patch.name) {
      const slug = slugify(patch.name);
      const dup = await knex('localities').where({ city_id: existing.city_id, slug }).whereNot('id', existing.id).first();
      if (dup) return res.status(409).json({ error: { code: 'DUPLICATE_AREA', message: 'Area already exists in this city' }, existing_id: dup.id });
      patch.slug = slug;
    }

    patch.updated_at = knex.fn.now();
    const [row] = await knex('localities').where({ id: req.params.id }).update(patch).returning('*');
    matcher.invalidate(row.city_id);
    res.json(row);
  }));

  r.post('/localities/:id/verify', wrap(async (req, res) => {
    const { center_lat, center_lng, radius_m } = req.body;
    if (center_lat == null || center_lng == null) {
      return res.status(400).json(err('VALIDATION_ERROR', 'center_lat and center_lng are required to verify'));
    }
    const existing = await knex('localities').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json(err('NOT_FOUND', 'not found'));
    const geoErr = await validateAreaGeo(existing.city_id, center_lat, center_lng, radius_m ?? existing.radius_m);
    if (geoErr) return res.status(400).json(err('OUT_OF_BOUNDS', geoErr));

    const [row] = await knex('localities').where({ id: req.params.id })
      .update({ center_lat, center_lng, radius_m: radius_m ?? existing.radius_m, status: 'active', updated_at: knex.fn.now() })
      .returning('*');
    matcher.invalidate(row.city_id);
    res.json(row);
  }));

  r.post('/localities/:id/aliases', wrap(async (req, res) => {
    const loc = await knex('localities').where({ id: req.params.id }).first();
    if (!loc) return res.status(404).json(err('NOT_FOUND', 'not found'));
    const norm = normalize(req.body.alias);
    if (!norm) return res.status(400).json(err('VALIDATION_ERROR', 'alias required'));
    const clash = await knex('locality_aliases as a')
      .join('localities as l', 'l.id', 'a.locality_id')
      .where('l.city_id', loc.city_id).where('a.alias_normalized', norm).whereNot('a.locality_id', loc.id)
      .select('l.name').first();
    if (clash) return res.status(409).json(err('ALIAS_IN_USE', `Alias already used by ${clash.name}`));
    await knex('locality_aliases')
      .insert({ locality_id: loc.id, alias: req.body.alias.trim(), alias_normalized: norm, source: 'manual' })
      .onConflict(['locality_id', 'alias_normalized']).ignore();
    matcher.invalidate(loc.city_id);
    res.status(201).json({ ok: true });
  }));

  r.delete('/localities/aliases/:aliasId', wrap(async (req, res) => {
    const a = await knex('locality_aliases as a').join('localities as l', 'l.id', 'a.locality_id')
      .where('a.id', req.params.aliasId).select('l.city_id').first();
    await knex('locality_aliases').where({ id: req.params.aliasId }).del();
    if (a) matcher.invalidate(a.city_id);
    res.json({ ok: true });
  }));

  r.post('/localities/:id/merge', wrap(async (req, res) => {
    const { into_id } = req.body;
    if (!into_id) return res.status(400).json(err('VALIDATION_ERROR', 'into_id required'));
    const [source, target] = await Promise.all([
      knex('localities').where({ id: req.params.id }).first(),
      knex('localities').where({ id: into_id }).first(),
    ]);
    if (!source || !target) return res.status(404).json(err('NOT_FOUND', 'locality not found'));
    if (source.city_id !== target.city_id) return res.status(400).json(err('CITY_MISMATCH', 'Can only merge areas within the same city'));
    if (source.id === target.id) return res.status(400).json(err('VALIDATION_ERROR', 'Cannot merge an area into itself'));

    await knex.transaction(async (trx) => {
      const existingTargetAliases = await trx('locality_aliases').where({ locality_id: target.id }).pluck('alias_normalized');
      await trx('locality_aliases').where({ locality_id: source.id }).whereNotIn('alias_normalized', existingTargetAliases).update({ locality_id: target.id });
      await trx('locality_aliases').where({ locality_id: source.id }).del(); // any leftover clashes
      await trx('listings').where({ locality_id: source.id }).update({ locality_id: target.id });
      await trx('locality_unmatched').where({ suggested_locality_id: source.id }).update({ suggested_locality_id: target.id });
      await trx('locality_unmatched').where({ resolved_locality_id: source.id }).update({ resolved_locality_id: target.id });
      await trx('localities').where({ id: source.id }).update({ status: 'disabled', updated_at: trx.fn.now() });
    });
    matcher.invalidate(source.city_id);
    res.json({ ok: true, merged_into: target.id });
  }));

  // ---------------------------------------------------------------------
  // Bulk CSV import
  // ---------------------------------------------------------------------

  r.post('/cities/:cityId/localities/import/preview', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json(err('VALIDATION_ERROR', 'CSV file required (field name "file")'));
    const result = await importLocalities({
      knex, cityId: Number(req.params.cityId), csvText: req.file.buffer.toString('utf8'),
      geocode: false, write: false,
    });
    res.json(result);
  }));

  r.post('/cities/:cityId/localities/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json(err('VALIDATION_ERROR', 'CSV file required (field name "file")'));
    const geocode = req.body.geocode === 'true' || req.body.geocode === true;
    const result = await importLocalities({
      knex, cityId: Number(req.params.cityId), csvText: req.file.buffer.toString('utf8'),
      geocode, apiKey: process.env.GOOGLE_MAPS_API_KEY, write: true,
    });
    matcher.invalidate(Number(req.params.cityId));
    res.json(result);
  }));

  // ---------------------------------------------------------------------
  // Unmatched queue and test box
  // ---------------------------------------------------------------------

  r.get('/cities/:cityId/unmatched', wrap(async (req, res) => {
    // Joined in so the admin UI's "Listing" link can point at the real
    // public page (/p/:public_slug) instead of the raw internal listing id,
    // which the public route never accepts (publicListingController.js
    // matches on public_slug only, no numeric-id fallback).
    const rows = await knex('locality_unmatched as u')
      .leftJoin('localities as s', 's.id', 'u.suggested_locality_id')
      .leftJoin('listings as li', 'li.id', 'u.listing_id')
      .where('u.city_id', req.params.cityId)
      .where('u.status', req.query.status || 'pending')
      .select('u.*', 's.name as suggested_name', 'li.public_slug as listing_slug', 'li.title as listing_title')
      .orderBy([{ column: 'u.seen_count', order: 'desc' }, { column: 'u.updated_at', order: 'desc' }])
      .limit(200);
    res.json(rows);
  }));

  r.post('/unmatched/:id/resolve', wrap(async (req, res) => {
    const u = await knex('locality_unmatched').where({ id: req.params.id }).first();
    if (!u) return res.status(404).json(err('NOT_FOUND', 'not found'));
    let localityId = req.body.locality_id;

    if (!localityId && req.body.create) {
      const c = req.body.create;
      const geoErr = await validateAreaGeo(u.city_id, c.center_lat, c.center_lng, c.radius_m);
      if (geoErr) return res.status(400).json(err('OUT_OF_BOUNDS', geoErr));
      [{ id: localityId }] = await knex('localities')
        .insert({
          city_id: u.city_id, name: c.name, slug: slugify(c.name), kind: c.kind || 'area',
          center_lat: c.center_lat ?? null, center_lng: c.center_lng ?? null, radius_m: c.radius_m || 1000,
          status: c.center_lat != null ? 'active' : 'needs_review', source: 'admin',
        })
        .returning('id');
      await knex('locality_aliases')
        .insert({ locality_id: localityId, alias: c.name, alias_normalized: normalize(c.name), source: 'manual' })
        .onConflict(['locality_id', 'alias_normalized']).ignore();
    }
    if (!localityId) return res.status(400).json(err('VALIDATION_ERROR', 'locality_id or create required'));

    let learned = null;
    if (req.body.alias_phrase) {
      learned = await matcher.confirm({ cityId: u.city_id, localityId, phrase: req.body.alias_phrase, source: 'manual' });
    }
    if (u.listing_id) {
      await knex('listings').where({ id: u.listing_id }).update({
        locality_id: localityId, locality_match_method: 'admin', locality_match_confidence: 1,
      });
    }
    await knex('locality_unmatched').where({ id: u.id })
      .update({ status: 'resolved', resolved_locality_id: localityId, updated_at: knex.fn.now() });
    matcher.invalidate(u.city_id);
    res.json({ ok: true, locality_id: localityId, learned });
  }));

  r.post('/unmatched/:id/ignore', wrap(async (req, res) => {
    await knex('locality_unmatched').where({ id: req.params.id }).update({ status: 'ignored', updated_at: knex.fn.now() });
    res.json({ ok: true });
  }));

  // Debug box in admin panel: paste any address, see what the matcher does.
  // requireLive:false — this is the ONE way a draft (not-yet-live) city can
  // be tried before go-live. Never records to the unmatched queue.
  r.post('/cities/:cityId/test-match', wrap(async (req, res) => {
    const { text, lat, lng } = req.body;
    const result = await matcher.match({ cityId: Number(req.params.cityId), text, lat, lng, record: false, requireLive: false });
    res.json(result);
  }));

  return r;
}

module.exports = { createLocalityAdminRouter };
