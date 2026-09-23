/**
 * Super-admin API for the locality master.
 *
 * Mounted under src/routes/admin.js, which already applies
 * authGuard + adminGuard (super_admin only) to everything registered on
 * that router — no separate guard needed here.
 *
 * localities / locality_aliases / locality_unmatched have no tenant_id
 * column and no RLS policy (see migration 20260922_01), so a plain,
 * dedicated knex connection (same pattern as the worker files, e.g.
 * geoEnrichmentWorker.js) is enough — no per-request req.dbTrx needed,
 * including for the listings joins/updates below: Phase 5 RLS
 * (20260704_02) only restricts rows once app.current_tenant_id is set,
 * which a connection like this one never does, so it sees every tenant's
 * rows exactly like the worker files already do.
 */

const express = require('express');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { normalize, slugify } = require('../services/locality/normalize');
const { createLocalityMatcher } = require('../services/locality/localityMatcher');

const matcher = createLocalityMatcher({ knex });

function createLocalityAdminRouter() {
  const r = express.Router();

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => {
      console.error('[admin-localities]', err);
      res.status(500).json({ error: err.message });
    });

  // List localities (with aliases + how many listings use each)
  r.get('/localities', wrap(async (req, res) => {
    const { city, status, q } = req.query;
    const qb = knex('localities as l')
      .leftJoin('listings as li', 'li.locality_id', 'l.id')
      .groupBy('l.id')
      .select('l.*', knex.raw('count(li.id)::int as listing_count'))
      .orderBy('l.name');
    if (city) qb.whereRaw('lower(l.city) = ?', [city.toLowerCase()]);
    if (status) qb.where('l.status', status);
    if (q) qb.whereILike('l.name', `%${q}%`);
    const rows = await qb;
    const aliases = rows.length
      ? await knex('locality_aliases').whereIn('locality_id', rows.map((x) => x.id)).select('id', 'locality_id', 'alias', 'source')
      : [];
    for (const row of rows) row.aliases = aliases.filter((a) => a.locality_id === row.id);
    res.json(rows);
  }));

  r.post('/localities', wrap(async (req, res) => {
    const { city, name, kind = 'area', parent_id, pincode, center_lat, center_lng, radius_m = 1000, aliases = [] } = req.body;
    if (!city || !name) return res.status(400).json({ error: 'city and name required' });
    const [{ id }] = await knex('localities')
      .insert({
        city, name, slug: slugify(name), kind, parent_id: parent_id || null, pincode: pincode || null,
        center_lat, center_lng, radius_m, status: center_lat != null ? 'active' : 'needs_review', source: 'admin',
      })
      .returning('id');
    const aliasRows = [...new Set([name, ...aliases])]
      .map((a) => ({ locality_id: id, alias: a, alias_normalized: normalize(a), source: 'manual' }))
      .filter((a) => a.alias_normalized);
    await knex('locality_aliases').insert(aliasRows).onConflict(['locality_id', 'alias_normalized']).ignore();
    matcher.invalidate(city);
    res.status(201).json({ id });
  }));

  // Edit / verify. Setting status:'active' = "I checked the pin on the map, it's right".
  r.patch('/localities/:id', wrap(async (req, res) => {
    const allowed = ['name', 'kind', 'parent_id', 'pincode', 'center_lat', 'center_lng', 'radius_m', 'boundary', 'status'];
    const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (patch.name) patch.slug = slugify(patch.name);
    patch.updated_at = knex.fn.now();
    const [row] = await knex('localities').where({ id: req.params.id }).update(patch).returning('*');
    if (!row) return res.status(404).json({ error: 'not found' });
    matcher.invalidate(row.city);
    res.json(row);
  }));

  r.post('/localities/:id/aliases', wrap(async (req, res) => {
    const loc = await knex('localities').where({ id: req.params.id }).first();
    if (!loc) return res.status(404).json({ error: 'not found' });
    const norm = normalize(req.body.alias);
    if (!norm) return res.status(400).json({ error: 'alias required' });
    const clash = await knex('locality_aliases as a')
      .join('localities as l', 'l.id', 'a.locality_id')
      .where('l.city', loc.city).where('a.alias_normalized', norm).whereNot('a.locality_id', loc.id)
      .select('l.name').first();
    if (clash) return res.status(409).json({ error: `Alias already used by ${clash.name}` });
    await knex('locality_aliases')
      .insert({ locality_id: loc.id, alias: req.body.alias.trim(), alias_normalized: norm, source: 'manual' })
      .onConflict(['locality_id', 'alias_normalized']).ignore();
    matcher.invalidate(loc.city);
    res.status(201).json({ ok: true });
  }));

  r.delete('/localities/aliases/:aliasId', wrap(async (req, res) => {
    const a = await knex('locality_aliases as a').join('localities as l', 'l.id', 'a.locality_id')
      .where('a.id', req.params.aliasId).select('l.city').first();
    await knex('locality_aliases').where({ id: req.params.aliasId }).del();
    if (a) matcher.invalidate(a.city);
    res.json({ ok: true });
  }));

  // Unmatched queue: most frequent first, so fixing one row fixes many listings
  r.get('/localities/unmatched', wrap(async (req, res) => {
    const rows = await knex('locality_unmatched as u')
      .leftJoin('localities as s', 's.id', 'u.suggested_locality_id')
      .where('u.status', req.query.status || 'pending')
      .modify((qb) => { if (req.query.city) qb.whereRaw('lower(u.city) = ?', [req.query.city.toLowerCase()]); })
      .select('u.*', 's.name as suggested_name')
      .orderBy([{ column: 'u.seen_count', order: 'desc' }, { column: 'u.updated_at', order: 'desc' }])
      .limit(200);
    res.json(rows);
  }));

  // Resolve: map to an existing locality (optionally learn the phrase) or create a new one
  r.post('/localities/unmatched/:id/resolve', wrap(async (req, res) => {
    const u = await knex('locality_unmatched').where({ id: req.params.id }).first();
    if (!u) return res.status(404).json({ error: 'not found' });
    let localityId = req.body.locality_id;

    if (!localityId && req.body.create) {
      const c = req.body.create;
      [{ id: localityId }] = await knex('localities')
        .insert({
          city: u.city, name: c.name, slug: slugify(c.name), kind: c.kind || 'area',
          center_lat: c.center_lat ?? null, center_lng: c.center_lng ?? null, radius_m: c.radius_m || 1000,
          status: c.center_lat != null ? 'active' : 'needs_review', source: 'admin',
        })
        .returning('id');
      await knex('locality_aliases')
        .insert({ locality_id: localityId, alias: c.name, alias_normalized: normalize(c.name), source: 'manual' })
        .onConflict(['locality_id', 'alias_normalized']).ignore();
    }
    if (!localityId) return res.status(400).json({ error: 'locality_id or create required' });

    let learned = null;
    if (req.body.alias_phrase) {
      learned = await matcher.confirm({ city: u.city, localityId, phrase: req.body.alias_phrase, source: 'manual' });
    }
    if (u.listing_id) {
      await knex('listings').where({ id: u.listing_id }).update({
        locality_id: localityId, locality_match_method: 'admin', locality_match_confidence: 1,
      });
    }
    await knex('locality_unmatched').where({ id: u.id })
      .update({ status: 'resolved', resolved_locality_id: localityId, updated_at: knex.fn.now() });
    matcher.invalidate(u.city);
    res.json({ ok: true, locality_id: localityId, learned });
  }));

  r.post('/localities/unmatched/:id/ignore', wrap(async (req, res) => {
    await knex('locality_unmatched').where({ id: req.params.id }).update({ status: 'ignored', updated_at: knex.fn.now() });
    res.json({ ok: true });
  }));

  // Debug box in admin panel: paste any address, see what the matcher does
  r.post('/localities/test-match', wrap(async (req, res) => {
    const { city, text, lat, lng } = req.body;
    res.json(await matcher.match({ city, text, lat, lng, record: false }));
  }));

  return r;
}

module.exports = { createLocalityAdminRouter };
