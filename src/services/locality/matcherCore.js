/**
 * Deterministic locality matching. Pure functions, no DB / network, so it's easy to test.
 *
 * Input "index" is built once per city from DB rows:
 *   buildIndex([{ id, name, kind, parent_id, pincode, aliases: ['dugri 2', ...] }, ...])
 *
 * Stages (first confident one wins):
 *   1. exact     - whole text equals an alias                       (conf 1.00)
 *   2. contains  - an alias appears as whole words inside the text  (conf 0.95, 0.80 if after "near/opp")
 *   3. fuzzy     - a word-window is a close spelling of an alias    (conf = similarity * 0.95)
 * Anything not confident is returned with candidates so the LLM stage / dealer can decide.
 */

const { normalize, extractPincode, PROXIMITY_WORDS } = require('./normalize');

const KIND_PRIORITY = { sector: 4, area: 3, industrial: 3, town: 2, road: 1 };
const AUTO_ACCEPT = 0.85;
const ASK_DEALER = 0.6;
const MIN_FUZZY_ALIAS_LEN = 5;

function buildIndex(localities) {
  const byId = new Map();
  const aliases = []; // { norm, tokens, localityId }
  for (const loc of localities) {
    byId.set(loc.id, loc);
    const all = new Set([loc.name, ...(loc.aliases || [])].map(normalize).filter(Boolean));
    for (const norm of all) aliases.push({ norm, tokens: norm.split(' '), localityId: loc.id });
  }
  // Longest alias first so "dugri phase 2" is tried before "dugri"
  aliases.sort((a, b) => b.norm.length - a.norm.length);
  return { byId, aliases };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

// Numbers must agree exactly: "phase 2" vs "phase 3" is a different locality, not a typo.
function numbersAgree(a, b) {
  const na = (a.match(/\d+[a-z]?/g) || []).join('|');
  const nb = (b.match(/\d+[a-z]?/g) || []).join('|');
  return na === nb;
}

function findTokenRun(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function pushBest(map, localityId, entry) {
  const prev = map.get(localityId);
  if (!prev || entry.score > prev.score) map.set(localityId, entry);
}

function rank(index, hits, pincode) {
  return [...hits.values()]
    .map((h) => {
      const loc = index.byId.get(h.localityId);
      let score = h.score;
      if (pincode && loc.pincode && loc.pincode === pincode) score = Math.min(1, score + 0.03);
      if (pincode && loc.pincode && loc.pincode !== pincode) score -= 0.05;
      return { ...h, score, kindPriority: KIND_PRIORITY[loc.kind] || 0, name: loc.name };
    })
    .sort((a, b) => b.score - a.score || b.kindPriority - a.kindPriority || b.aliasLen - a.aliasLen);
}

// If the text mentions both "Dugri" and "Dugri Phase 2", keep only the more specific child.
function dropCoveredParents(index, ranked) {
  const ids = new Set(ranked.map((r) => r.localityId));
  return ranked.filter((r) => {
    for (const other of ids) {
      const o = index.byId.get(other);
      if (o && o.parent_id === r.localityId) return false;
    }
    return true;
  });
}

// "model town extension" also contains "model town" -> the shorter match inside the longer one is noise
function dropNestedSpans(ranked) {
  return ranked.filter(
    (r) =>
      !ranked.some(
        (o) =>
          o !== r &&
          o.localityId !== r.localityId &&
          o.start <= r.start &&
          o.end >= r.end &&
          o.end - o.start > r.end - r.start
      )
  );
}

function matchText(index, rawText) {
  const text = normalize(rawText);
  const pincode = extractPincode(rawText);
  const tokens = text ? text.split(' ') : [];
  const empty = { text, pincode, best: null, candidates: [], decision: 'unmatched' };
  if (!tokens.length) return empty;

  // 1. exact
  for (const a of index.aliases) {
    if (a.norm === text) {
      const best = { localityId: a.localityId, name: index.byId.get(a.localityId).name, score: 1, method: 'exact', matched: a.norm };
      return { text, pincode, best, candidates: [best], decision: 'auto' };
    }
  }

  // 2. contains (whole-word runs)
  const hits = new Map();
  for (const a of index.aliases) {
    const at = findTokenRun(tokens, a.tokens);
    if (at === -1) continue;
    const prevWord = tokens[at - 1];
    const isReference = prevWord && PROXIMITY_WORDS.has(prevWord);
    pushBest(hits, a.localityId, {
      localityId: a.localityId,
      score: isReference ? 0.8 : 0.95,
      method: 'contains',
      matched: a.norm,
      aliasLen: a.norm.length,
      isReference,
      start: at,
      end: at + a.tokens.length,
    });
  }

  // 3. fuzzy, only if contains found nothing solid
  const solid = [...hits.values()].some((h) => !h.isReference);
  if (!solid) {
    for (const a of index.aliases) {
      if (a.norm.length < MIN_FUZZY_ALIAS_LEN) continue;
      const n = a.tokens.length;
      for (let w = Math.max(1, n - 1); w <= n + 1; w++) {
        for (let i = 0; i + w <= tokens.length; i++) {
          const windowText = tokens.slice(i, i + w).join(' ');
          if (!numbersAgree(windowText, a.norm)) continue;
          const sim = similarity(windowText, a.norm);
          if (sim < 0.72) continue;
          const isReference = i > 0 && PROXIMITY_WORDS.has(tokens[i - 1]);
          pushBest(hits, a.localityId, {
            localityId: a.localityId,
            score: sim * (isReference ? 0.8 : 0.95),
            method: 'fuzzy',
            matched: windowText,
            aliasLen: a.norm.length,
            isReference,
            start: i,
            end: i + w,
          });
        }
      }
    }
  }

  const ranked = dropCoveredParents(index, dropNestedSpans(rank(index, hits, pincode)));
  if (!ranked.length) return empty;

  const best = ranked[0];
  const runnerUp = ranked[1];
  // "Sarabha Nagar, Pakhowal Road" is not ambiguous: the area is more specific than the road.
  const ambiguous =
    runnerUp &&
    !runnerUp.isReference &&
    !best.isReference &&
    best.score - runnerUp.score < 0.03 &&
    best.kindPriority === runnerUp.kindPriority;

  let decision;
  if (best.score >= AUTO_ACCEPT && !ambiguous) decision = 'auto';
  else if (best.score >= ASK_DEALER) decision = 'confirm';
  else decision = 'unmatched';

  return { text, pincode, best, candidates: ranked.slice(0, 5), decision, ambiguous: !!ambiguous };
}

module.exports = { buildIndex, matchText, similarity, AUTO_ACCEPT, ASK_DEALER };
