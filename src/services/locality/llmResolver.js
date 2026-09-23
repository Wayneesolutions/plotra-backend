/**
 * LLM fallback: only called when the deterministic matcher isn't confident.
 * The model may ONLY pick an id from the list we send, so it can't invent localities.
 *
 * Env:
 *   LOCALITY_LLM_PROVIDER = anthropic | openai        (default anthropic)
 *   LOCALITY_LLM_MODEL    = override model name
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY
 */

const TIMEOUT_MS = 8000;

function buildPrompt(city, rawText, localities) {
  const list = localities
    .map((l) => `${l.id} | ${l.name}${l.aliases && l.aliases.length ? ' | ' + l.aliases.slice(0, 6).join(', ') : ''}`)
    .join('\n');
  return `You map Indian property addresses to a fixed list of localities in ${city}.
Dealers write in English, Hinglish, Punjabi (Gurmukhi) or Hindi, with typos and shorthand.

LOCALITIES (id | name | known spellings):
${list}

ADDRESS FROM DEALER:
"""${rawText}"""

Rules:
- Pick the locality the PROPERTY is in. Words like "near", "opp", "ke paas", "ਨੇੜੇ" mark a landmark, not the property's locality.
- Prefer the most specific match (a phase/sector over its parent area, an area over a road).
- Phase/sector numbers must match exactly. Never guess a different number.
- If none of the listed localities fits, return null. Do not force a match.
- matched_phrase = the exact words from the address that name the locality (copy them as written), or null.

Reply with ONLY this JSON, no other text:
{"locality_id": <id or null>, "confidence": <0 to 1>, "matched_phrase": <string or null>, "unknown_locality_name": <name the dealer used if it's not in the list, else null>}`;
}

async function callAnthropic(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.LOCALITY_LLM_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

async function callOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LOCALITY_LLM_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

function parseReply(text, allowedIds) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const id = obj.locality_id == null ? null : Number(obj.locality_id);
  if (id != null && !allowedIds.has(id)) return null; // hallucinated id -> reject
  return {
    localityId: id,
    confidence: Math.max(0, Math.min(0.9, Number(obj.confidence) || 0)), // LLM never gets > 0.9
    matchedPhrase: typeof obj.matched_phrase === 'string' ? obj.matched_phrase : null,
    unknownLocalityName: typeof obj.unknown_locality_name === 'string' ? obj.unknown_locality_name : null,
  };
}

/**
 * @param {object} p
 * @param {string} p.city
 * @param {string} p.rawText
 * @param {Array}  p.localities  [{id, name, aliases}] - send candidates first; whole city list is fine (~300 rows)
 * @param {function} [p.call]    injectable for tests
 */
async function resolveWithLLM({ city, rawText, localities, call }) {
  const provider = (process.env.LOCALITY_LLM_PROVIDER || 'anthropic').toLowerCase();
  const caller = call || (provider === 'openai' ? callOpenAI : callAnthropic);
  const allowedIds = new Set(localities.map((l) => Number(l.id)));
  try {
    const reply = await caller(buildPrompt(city, rawText, localities));
    return parseReply(reply, allowedIds);
  } catch (err) {
    console.error('[locality-llm] failed:', err.message);
    return null; // matcher falls back to asking the dealer
  }
}

module.exports = { resolveWithLLM, buildPrompt, parseReply };
