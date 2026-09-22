/**
 * Locality matcher service — the one thing the rest of Plotra calls.
 *
 *   const matcher = createLocalityMatcher({ knex });
 *   const r = await matcher.match({ city: 'Ludhiana', text: 'plot dugri ph-2', lat, lng, listingId });
 *
 *   r.decision:
 *     'auto'     -> save r.localityId on the listing, no question to dealer
 *     'confirm'  -> ask dealer "Aapki property <r.name> mein hai?" (see README for message)
 *     'unmatched'-> ask dealer to share location pin / pick area; row queued for super-admin
 *   r.pin: { verdict: inside|near|outside|unknown, distanceM, suggestions:[...] } when lat/lng given
 *
 * After the dealer says "Haan" (or admin resolves), call matcher.confirm(...) so the
 * spelling the dealer used becomes a new alias and next time it's an instant match.
 */

const { normalize } = require('./normalize');
const { buildIndex, matchText, AUTO_ACCEPT } = require('./matcherCore');
const { resolveWithLLM } = require('./llmResolver');
const { checkPin, localitiesForPoint } = require('./geoCheck');

const CACHE_TTL_MS = 10 * 60 * 1000;

function createLocalityMatcher({ knex, llm = resolveWithLLM, useLLM = true, logger = console }) {
  const cache = new Map(); // cityKey -> { at, rows, index }

  const cityKey = (city) => String(city || '').trim().toLowerCase();

  async function load(city) {
    const key = cityKey(city);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

    const rows = await knex('localities')
      .whereRaw('lower(city) = ?', [key])
      .whereNot('status', 'disabled')
      .select('id', 'name', 'kind', 'parent_id', 'pincode', 'center_lat', 'center_lng', 'radius_m', 'boundary', 'status');
    const aliasRows = rows.length
      ? await knex('locality_aliases').whereIn('locality_id', rows.map((r) => r.id)).select('locality_id', 'alias')
      : [];
    const aliasMap = new Map();
    for (const a of aliasRows) {
      if (!aliasMap.has(a.locality_id)) aliasMap.set(a.locality_id, []);
      aliasMap.get(a.locality_id).push(a.alias);
    }
    for (const r of rows) r.aliases = aliasMap.get(r.id) || [];

    const entry = { at: Date.now(), rows, index: buildIndex(rows) };
    cache.set(key, entry);
    return entry;
  }

  function invalidate(city) {
    if (city) cache.delete(cityKey(city));
    else cache.clear();
  }

  async function queueUnmatched({ city, text, normalized, listingId, suggestion }) {
    if (!normalized) return;
    try {
      await knex('locality_unmatched')
        .insert({
          city,
          raw_text: text,
          normalized: normalized.slice(0, 300),
          listing_id: listingId || null,
          suggested_locality_id: suggestion ? suggestion.localityId : null,
          suggested_confidence: suggestion ? suggestion.score : null,
        })
        .onConflict(['city', 'normalized'])
        .merge({
          seen_count: knex.raw('locality_unmatched.seen_count + 1'),
          listing_id: listingId || knex.raw('locality_unmatched.listing_id'),
          updated_at: knex.fn.now(),
        });
    } catch (err) {
      logger.error('[locality] queueUnmatched failed:', err.message);
    }
  }

  async function match({ city, text, lat = null, lng = null, listingId = null, record = true }) {
    const { rows, index } = await load(city);
    if (!rows.length) {
      return { decision: 'unmatched', reason: 'no_localities_for_city', localityId: null, candidates: [] };
    }

    let result = matchText(index, text);
    let method = result.best ? result.best.method : null;
    let best = result.best;

    // LLM only when deterministic stages weren't confident
    if (useLLM && result.decision !== 'auto') {
      // candidates first, then the rest of the city, so the model sees likely options up top
      const candidateIds = new Set(result.candidates.map((c) => c.localityId));
      const ordered = [...rows.filter((r) => candidateIds.has(r.id)), ...rows.filter((r) => !candidateIds.has(r.id))];
      const llmRes = await llm({ city, rawText: text, localities: ordered });
      if (llmRes && llmRes.localityId != null) {
        const agreesWithBest = best && best.localityId === llmRes.localityId;
        // Deterministic + LLM agreeing is strong evidence; LLM alone is capped at "confirm" territory
        const score = agreesWithBest ? Math.max(best.score, AUTO_ACCEPT) : Math.min(llmRes.confidence, 0.84);
        best = {
          localityId: llmRes.localityId,
          name: index.byId.get(llmRes.localityId).name,
          score,
          method: agreesWithBest ? `${best.method}+llm` : 'llm',
          matched: llmRes.matchedPhrase,
        };
        method = best.method;
        result = {
          ...result,
          best,
          decision: score >= AUTO_ACCEPT ? 'auto' : score >= 0.6 ? 'confirm' : 'unmatched',
        };
      }
      result.llmUnknownName = llmRes ? llmRes.unknownLocalityName : null;
    }

    // Pin cross-check
    let pin = null;
    if (lat != null && lng != null) {
      pin = { suggestions: localitiesForPoint(rows, lat, lng) };
      if (best) {
        const loc = rows.find((r) => r.id === best.localityId);
        Object.assign(pin, checkPin(loc, lat, lng));
        // Text says Dugri, pin is 5 km away in verified coords -> don't auto-accept
        if (pin.verdict === 'outside' && pin.coordsVerified && result.decision === 'auto') {
          result.decision = 'confirm';
          result.reason = 'pin_outside_locality';
        }
        // Weak text match but the pin sits inside that same locality -> good enough
        if ((pin.verdict === 'inside' || pin.verdict === 'near') && result.decision === 'confirm' && !result.ambiguous) {
          result.decision = 'auto';
          result.reason = 'pin_confirms_text';
        }
      } else if (pin.suggestions.length === 1 && pin.suggestions[0].verdict === 'inside') {
        // No text match at all, but the pin clearly sits in one locality
        const s = pin.suggestions[0];
        best = { localityId: s.id, name: s.name, score: 0.8, method: 'pin', matched: null };
        method = 'pin';
        result = { ...result, best, decision: 'confirm', reason: 'from_pin_only' };
      }
    }

    if (record && result.decision === 'unmatched') {
      await queueUnmatched({ city, text, normalized: result.text, listingId, suggestion: best });
    }

    return {
      decision: result.decision,
      reason: result.reason || null,
      localityId: best && result.decision !== 'unmatched' ? best.localityId : null,
      name: best ? best.name : null,
      confidence: best ? Number(best.score.toFixed(3)) : 0,
      method,
      matchedPhrase: best ? best.matched : null,
      ambiguous: !!result.ambiguous,
      candidates: (result.candidates || []).map((c) => ({ localityId: c.localityId, name: c.name, score: Number(c.score.toFixed(3)) })),
      unknownLocalityName: result.llmUnknownName || null,
      pincode: result.pincode || null,
      pin,
    };
  }

  /**
   * Dealer said "Haan" / admin picked the right locality.
   * Learns the phrase as an alias (only human-confirmed matches are ever learned).
   */
  async function confirm({ city, localityId, phrase, source = 'learned' }) {
    const norm = normalize(phrase || '');
    if (!norm || norm.length < 4) return { learned: false };
    // Don't learn a phrase that already points at a different locality in this city
    const clash = await knex('locality_aliases as a')
      .join('localities as l', 'l.id', 'a.locality_id')
      .whereRaw('lower(l.city) = ?', [cityKey(city)])
      .where('a.alias_normalized', norm)
      .whereNot('a.locality_id', localityId)
      .first();
    if (clash) return { learned: false, reason: 'alias_belongs_to_other_locality' };

    await knex('locality_aliases')
      .insert({ locality_id: localityId, alias: phrase.trim().slice(0, 200), alias_normalized: norm, source })
      .onConflict(['locality_id', 'alias_normalized'])
      .ignore();
    invalidate(city);
    return { learned: true };
  }

  /** Save the match result on a listing row. */
  async function applyToListing(listingId, res) {
    if (!listingId || !res || !res.localityId) return;
    await knex('listings').where({ id: listingId }).update({
      locality_id: res.localityId,
      locality_match_method: res.method,
      locality_match_confidence: res.confidence,
      locality_pin_verdict: res.pin ? res.pin.verdict || 'unknown' : null,
    });
  }

  return { match, confirm, applyToListing, invalidate, load };
}

module.exports = { createLocalityMatcher };
