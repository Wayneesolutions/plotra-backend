// src/services/tenantCityService.js
//
// Multi-city tenants (migration 20260924_01_multi_city_tenants.js).
//
// - A tenant operates in one or more cities (tenant_cities). Each
//   (tenant, city) pair has its own permanent, city-wise code: LDH-002,
//   ASR-001. One city is primary; tenants.city_id mirrors it so older code
//   that reads tenants.city_id keeps working.
// - An agent can optionally be limited to some of the tenant's cities
//   (user_cities). With none set, the agent covers all of the tenant's cities.
// - geoEnrichmentWorker.js asks resolveCandidateCities() which cities a
//   listing could be in, and pickCityMatch() which one it actually is.

const CITY_CODE_RE = /^[A-Z]{2,4}$/;

function normalizeCityCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return CITY_CODE_RE.test(c) ? c : null;
}

/** First letter + following consonants: Ludhiana -> LDH, Amritsar -> AMR. */
function suggestCityCode(name) {
  const letters = String(name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return 'CTY';
  // First letter, then consonants, then vowels if still short:
  // Ludhiana -> LDH, Amritsar -> AMR, Una -> UNA.
  const rest = letters.slice(1).split('');
  const picked = [letters[0], ...rest.filter((ch) => !'AEIOU'.includes(ch)), ...rest.filter((ch) => 'AEIOU'.includes(ch))];
  return picked.join('').slice(0, 3).padEnd(3, 'X');
}

function formatTenantCode(cityCode, seq) {
  return `${cityCode}-${String(seq).padStart(3, '0')}`;
}

function uniqueInts(list) {
  return [...new Set((Array.isArray(list) ? list : [list]).filter((x) => x !== null && x !== undefined && x !== '').map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0);
}

class CityValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

/** Next code for a new tenant in this city, e.g. LDH-003. Row-locks the city. */
async function allocateTenantCode(trx, cityId) {
  const [row] = await trx('cities')
    .where({ id: cityId })
    .increment('tenant_seq', 1)
    .returning(['tenant_seq', 'code']);
  if (!row) throw new CityValidationError('INVALID_CITY', `City ${cityId} not found.`);
  if (!row.code) throw new CityValidationError('CITY_CODE_MISSING', 'This city has no code yet — set one in Cities & Areas first.');
  return formatTenantCode(row.code, row.tenant_seq);
}

/**
 * Validates a { cityIds, primaryCityId } choice against the cities table.
 * primaryCityId defaults to the first city. Throws CityValidationError.
 */
async function validateCityChoice(knex, { cityIds, primaryCityId }) {
  const ids = uniqueInts(cityIds);
  if (!ids.length) throw new CityValidationError('CITY_REQUIRED', 'Select at least one city.');
  const primary = primaryCityId != null && primaryCityId !== '' ? Number(primaryCityId) : ids[0];
  if (!ids.includes(primary)) throw new CityValidationError('INVALID_PRIMARY_CITY', 'Primary city must be one of the selected cities.');

  const rows = await knex('cities').whereIn('id', ids).select('id', 'name', 'state', 'status', 'code');
  if (rows.length !== ids.length) throw new CityValidationError('INVALID_CITY', 'One or more selected cities do not exist.');
  const disabled = rows.filter((r) => r.status === 'disabled');
  if (disabled.length) throw new CityValidationError('CITY_DISABLED', `City disabled: ${disabled.map((r) => r.name).join(', ')}`);
  const noCode = rows.filter((r) => !r.code);
  if (noCode.length) throw new CityValidationError('CITY_CODE_MISSING', `Set a city code first: ${noCode.map((r) => r.name).join(', ')}`);

  return { cityIds: ids, primaryCityId: primary, cities: rows, primaryCity: rows.find((r) => r.id === primary) };
}

/**
 * Makes the tenant's active cities exactly `cityIds`. New cities get a new
 * code; re-added cities get their old code back; removed cities are
 * deactivated (code kept) and dropped from agents' city lists. Syncs
 * tenants.city_id / operating_city / operating_state to the primary city.
 * Call inside a transaction. Returns the tenant's active city rows.
 */
async function setTenantCities(trx, tenantId, { cityIds, primaryCityId }) {
  const choice = await validateCityChoice(trx, { cityIds, primaryCityId });

  const existing = await trx('tenant_cities').where({ tenant_id: tenantId }).select('*');
  const byCity = new Map(existing.map((r) => [r.city_id, r]));

  // Clear primary first so the one-primary partial unique index never trips mid-update.
  await trx('tenant_cities').where({ tenant_id: tenantId }).update({ is_primary: false, updated_at: trx.fn.now() });

  for (const cityId of choice.cityIds) {
    const isPrimary = cityId === choice.primaryCityId;
    const row = byCity.get(cityId);
    if (row) {
      await trx('tenant_cities').where({ id: row.id }).update({ active: true, is_primary: isPrimary, updated_at: trx.fn.now() });
    } else {
      const code = await allocateTenantCode(trx, cityId);
      await trx('tenant_cities').insert({ tenant_id: tenantId, city_id: cityId, code, is_primary: isPrimary, active: true });
    }
  }

  const removed = existing.filter((r) => r.active && !choice.cityIds.includes(r.city_id)).map((r) => r.city_id);
  if (removed.length) {
    await trx('tenant_cities').where({ tenant_id: tenantId }).whereIn('city_id', removed)
      .update({ active: false, is_primary: false, updated_at: trx.fn.now() });
    await trx('user_cities')
      .whereIn('city_id', removed)
      .whereIn('user_id', trx('users').select('id').where({ tenant_id: tenantId }))
      .del();
  }

  await trx('tenants').where({ id: tenantId }).update({
    city_id: choice.primaryCityId,
    operating_city: choice.primaryCity.name,
    operating_state: choice.primaryCity.state,
    updated_at: trx.fn.now(),
  });

  return getTenantCities(trx, tenantId);
}

/** Active cities of one tenant, primary first. */
async function getTenantCities(knex, tenantId) {
  const map = await getTenantCitiesMap(knex, [tenantId]);
  return map.get(tenantId) || [];
}

/** Map tenantId -> [{ city_id, name, state, city_code, status, code, is_primary }] (active only, primary first). */
async function getTenantCitiesMap(knex, tenantIds) {
  const map = new Map();
  if (!tenantIds.length) return map;
  const rows = await knex('tenant_cities as tc')
    .join('cities as c', 'c.id', 'tc.city_id')
    .whereIn('tc.tenant_id', tenantIds)
    .where('tc.active', true)
    .select('tc.tenant_id', 'tc.city_id', 'tc.code', 'tc.is_primary', 'c.name', 'c.state', 'c.status', 'c.code as city_code')
    .orderBy([{ column: 'tc.is_primary', order: 'desc' }, { column: 'c.name', order: 'asc' }]);
  for (const r of rows) {
    if (!map.has(r.tenant_id)) map.set(r.tenant_id, []);
    map.get(r.tenant_id).push({
      city_id: r.city_id, name: r.name, state: r.state, status: r.status,
      city_code: r.city_code, code: r.code, is_primary: r.is_primary,
    });
  }
  return map;
}

/**
 * Sets an agent's cities (must be a subset of the tenant's active cities).
 * Empty list = agent covers all of the tenant's cities.
 */
async function setAgentCities(trx, tenantId, userId, cityIds) {
  const user = await trx('users').where({ id: userId, tenant_id: tenantId }).first('id', 'role');
  if (!user) throw Object.assign(new CityValidationError('NOT_FOUND', 'User not found in this tenant.'), { status: 404 });
  const ids = uniqueInts(cityIds);
  if (ids.length) {
    const allowed = await trx('tenant_cities').where({ tenant_id: tenantId, active: true }).whereIn('city_id', ids).pluck('city_id');
    const bad = ids.filter((id) => !allowed.includes(id));
    if (bad.length) throw new CityValidationError('CITY_NOT_IN_TENANT', 'Agent cities must be cities this tenant operates in.');
  }
  await trx('user_cities').where({ user_id: userId }).del();
  if (ids.length) await trx('user_cities').insert(ids.map((city_id) => ({ user_id: userId, city_id })));
  return ids;
}

/** Map userId -> [cityId] */
async function getUserCitiesMap(knex, userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const rows = await knex('user_cities').whereIn('user_id', userIds).select('user_id', 'city_id');
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push(r.city_id);
  }
  return map;
}

/**
 * Which cities could this listing be in? The agent's own cities if set
 * (limited to the tenant's active cities), else all of the tenant's active
 * cities (primary first), else the legacy tenants.city_id.
 * Returns [{ id, name, center_lat, center_lng, bounds_radius_km, status }].
 */
async function resolveCandidateCities(knex, { tenantId, agentUserId = null, legacyCityId = null }) {
  const tenantCities = await knex('tenant_cities as tc')
    .join('cities as c', 'c.id', 'tc.city_id')
    .where({ 'tc.tenant_id': tenantId, 'tc.active': true })
    .select('c.id', 'c.name', 'c.center_lat', 'c.center_lng', 'c.bounds_radius_km', 'c.status', 'tc.is_primary')
    .orderBy([{ column: 'tc.is_primary', order: 'desc' }, { column: 'c.name', order: 'asc' }]);

  if (agentUserId && tenantCities.length) {
    const agentCityIds = await knex('user_cities').where({ user_id: agentUserId }).pluck('city_id');
    const agentCities = tenantCities.filter((c) => agentCityIds.includes(c.id));
    if (agentCities.length) return agentCities;
  }
  if (tenantCities.length) return tenantCities;
  if (legacyCityId) {
    const c = await knex('cities').where({ id: legacyCityId }).first('id', 'name', 'center_lat', 'center_lng', 'bounds_radius_km', 'status');
    return c ? [c] : [];
  }
  return [];
}

function textMentionsCity(text, cityName) {
  if (!text || !cityName) return false;
  const esc = String(cityName).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(text);
}

const DECISION_RANK = { auto: 2, confirm: 1, unmatched: 0 };

/**
 * Picks the city a listing belongs to from per-city Locality Master
 * pre-matches. Order: best decision (auto > confirm > none), then a city
 * whose name appears in the address text, then higher confidence, then
 * candidate order (primary / agent's first city). With no match anywhere:
 * a city named in the text, else the first candidate.
 *
 * @param {Array<{city: {id, name}, match: object|null}>} results
 * @param {string} text  raw address
 * @returns {{ city: object, match: object|null } | null}
 */
function pickCityMatch(results, text) {
  if (!results || !results.length) return null;
  const scored = results.map((r, idx) => {
    const m = r.match;
    const matched = m && m.localityId && m.decision !== 'unmatched';
    return {
      r,
      idx,
      rank: matched ? (DECISION_RANK[m.decision] || 0) : 0,
      mentioned: textMentionsCity(text, r.city.name) ? 1 : 0,
      conf: matched ? Number(m.confidence) || 0 : 0,
    };
  });
  scored.sort((a, b) => b.rank - a.rank || b.mentioned - a.mentioned || b.conf - a.conf || a.idx - b.idx);
  return scored[0].r;
}

module.exports = {
  CityValidationError,
  normalizeCityCode,
  suggestCityCode,
  formatTenantCode,
  validateCityChoice,
  setTenantCities,
  getTenantCities,
  getTenantCitiesMap,
  setAgentCities,
  getUserCitiesMap,
  resolveCandidateCities,
  pickCityMatch,
  textMentionsCity,
};
