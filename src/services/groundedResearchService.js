const axios = require('axios');

/**
 * Shared web-search-grounded GPT calls, used by:
 *   - localIntelligenceWorker.js — neighborhood news/safety/seasonal context
 *   - builderDueDiligenceWorker.js — builder company background (stricter mode)
 *
 * This is a genuinely different OpenAI endpoint from the rest of the
 * codebase (vocallmWorker.js, agentIntakeWorker.js both call the closed-book
 * /v1/chat/completions endpoint with no internet access). The Responses API
 * (/v1/responses) with a web_search tool is what actually lets the model
 * look things up instead of guessing — required here specifically because
 * both features must never invent a crime rate, a company's financial
 * condition, or any other unstated fact. "Never invented" is enforced at
 * TWO levels, not just the system prompt: this file's filterCitedItems()
 * drops anything without a real source_url before a caller ever persists
 * it, and builder_profile_claims additionally has a NOT NULL DB constraint
 * on source_url as a second, structural backstop (see the migration).
 *
 * Response shape note: /v1/responses does NOT return choices[0].message.content
 * like /v1/chat/completions does. It returns response.data.output, an array
 * of items (typically a web_search_call item, then a message item). The
 * message item's content is an array of text blocks, each carrying an
 * annotations array of { type: 'url_citation', url, title } objects. This
 * is parsed defensively below rather than assuming one exact shape, since
 * combining web_search with strict JSON-schema mode is not confirmed to be
 * reliably supported — instead the prompts below ask for JSON-only output
 * and callers must handle JSON.parse failure as a real, expected outcome
 * (a failure mode the chat.completions callers elsewhere don't need, since
 * they use response_format: { type: 'json_object' }, unavailable here).
 */

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * Calls the Responses API with the web_search tool enabled and returns the
 * model's raw text output plus every real citation URL it attached.
 * Throws on a network/API error — callers running inside a BullMQ job
 * should let that propagate so the job retries normally.
 */
async function callWebSearchGroundedGPT({ systemPrompt, userPrompt, model = 'gpt-4o-mini' }) {
  const response = await axios.post(OPENAI_RESPONSES_URL, {
    model,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    tools: [{ type: 'web_search' }],
  }, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    timeout: 60000, // web search + generation genuinely takes longer than a closed-book call
  });

  const output = response.data?.output || [];
  const messageItem = output.find((item) => item.type === 'message');
  const contentBlocks = messageItem?.content || [];

  let text = '';
  const citationUrls = new Set();

  for (const block of contentBlocks) {
    if (typeof block.text === 'string') text += block.text;
    for (const annotation of block.annotations || []) {
      if (annotation.type === 'url_citation' && annotation.url) {
        citationUrls.add(annotation.url);
      }
    }
  }

  return { text, citationUrls: Array.from(citationUrls) };
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Drops any item whose source_url isn't a real http(s) URL. This is the
 * code-level enforcement of "never invented" — the prompt asks the model to
 * only state cited facts, but this function is what actually guarantees an
 * uncited claim never reaches the database, regardless of whether the model
 * followed instructions perfectly.
 */
function filterCitedItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && isValidHttpUrl(item.source_url));
}

/**
 * Same "no citation, doesn't exist" rule as filterCitedItems(), but for a
 * single nullable object (possession record) rather than an array —
 * generateBuilderClaims() below returns this as an at-most-one value, not
 * a list. Returns null if the item itself is null/malformed or its
 * source_url isn't a real URL — never a half-populated object with a
 * number but no citation.
 */
function filterCitedSingle(item) {
  if (!item || typeof item !== 'object') return null;
  if (!isValidHttpUrl(item.source_url)) return null;
  return item;
}

/**
 * Validates and normalizes the `rating` field, which — per the 2026-08-26
 * product decision — can be grounded in two different ways:
 *   - an external citation (source_url), the original 20260824 behavior, or
 *   - a synthesized 0-10 assessment (basis text) built from the claims
 *     this same research call already gathered and had cited.
 * Either way it's clamped to 0-10 and never accepted with NEITHER a
 * source_url NOR a basis — and a synthesized rating additionally requires
 * at least one actual cited claim to synthesize from (claimCount > 0):
 * a company nothing was found about gets no invented score just because
 * the model decided to guess one anyway.
 */
function validateRating(raw, claimCount) {
  if (!raw || typeof raw !== 'object') return null;
  const value = Number(raw.value);
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(0, Math.min(10, value));

  if (raw.is_ai_assessment) {
    const basis = typeof raw.basis === 'string' ? raw.basis.trim() : '';
    if (!basis || claimCount === 0) return null;
    return { value: clamped, basis, isAiAssessment: true, source_url: null, source_title: null };
  }

  if (!isValidHttpUrl(raw.source_url)) return null;
  return {
    value: clamped,
    source_url: raw.source_url,
    source_title: raw.source_title || null,
    isAiAssessment: false,
    basis: null,
  };
}

const LOCAL_INTEL_SYSTEM_PROMPT = `You research real, current, publicly-reported information about a specific location in India for a property-listing website. You MUST use the web_search tool to find REAL information — never invent facts, statistics, or crime figures, even plausible-sounding ones.

Return ONLY a JSON object with exactly these keys: news, safety, seasonal — each an array of objects shaped { "text": string, "source_url": string, "source_title": string }.

Rules:
- news: recent, genuinely locality-relevant news (development, civic issues, infrastructure). Not generic national news.
- safety: reported safety/crime information specific to this locality, ONLY if you find real reporting — a general "no widely-reported issues found" note without a source_url is not allowed either; if nothing reliable is found, return an empty array for this category.
- seasonal: known seasonal conditions relevant to buyers, e.g. flooding-prone roads in monsoon season, if genuinely reported for this specific area.
- EVERY item must have a real source_url from your search results. If you cannot find a citable source for something, omit it — do not include an item without a URL, and do not state a category confidently with no items just to seem thorough.
- If you find no reliable information for a category, return an empty array — never fill in a plausible-sounding guess.
- Output ONLY the JSON object, no markdown code fences, no other text.`;

/**
 * Feature 1: Local Intelligence. Returns { news, safety, seasonal, citationCount }
 * with every item guaranteed to carry a real citation (post-filter), or
 * throws if the underlying API call fails (let the worker's retry handle it).
 */
async function generateLocalIntelligence({ formattedAddress, propertyType }) {
  const userPrompt = `Location: ${formattedAddress}${propertyType ? ` (property type: ${propertyType})` : ''}\n\nFind real, current, cited local news, safety/crime reporting, and seasonal conditions (e.g. monsoon flooding) specific to this exact locality in India.`;

  const { text, citationUrls } = await callWebSearchGroundedGPT({
    systemPrompt: LOCAL_INTEL_SYSTEM_PROMPT,
    userPrompt,
  });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const parseError = new Error(`Local Intelligence: model output was not valid JSON: ${err.message}`);
    parseError.rawText = text;
    throw parseError;
  }

  const news = filterCitedItems(parsed.news);
  const safety = filterCitedItems(parsed.safety);
  const seasonal = filterCitedItems(parsed.seasonal);

  return {
    news,
    safety,
    seasonal,
    citationCount: news.length + safety.length + seasonal.length,
    rawResponseText: text,
    citationUrlsSeen: citationUrls.length,
  };
}

const BUILDER_DD_SYSTEM_PROMPT = `You research real, publicly-verifiable information about an Indian real-estate developer/builder company, for a buyer-facing due-diligence summary. This is legally sensitive: false claims about a real company or its named owners/directors is a defamation risk. You MUST use the web_search tool and cite every single fact you report to a real source.

Prioritize authoritative sources: RERA (India's Real Estate Regulatory Authority) state registries for project registration/delivery history, MCA (Ministry of Corporate Affairs) filings for company/director information, court records, and credible news outlets. Do not rely on the builder's own marketing materials as a sole source for delivery-history or financial claims.

Return ONLY a JSON object with exactly these keys:
{
  "claims": [ { "category": "delivery_history" | "leadership" | "financial_condition" | "rating" | "legal_issue", "claim_text": string, "source_url": string, "source_title": string, "source_domain": string }, ... ],
  "rating": { "value": number, "source_url": string, "source_title": string, "is_ai_assessment": false } | { "value": number, "basis": string, "is_ai_assessment": true } | null,
  "possession_record": { "delivered": number, "total": number, "source_url": string, "source_title": string } | null
}

Rules:
- Phrase every claim_text as attributed reporting, e.g. "Reported by [source] that..." or "According to RERA filings,..." — NEVER as a flat assertion of fact, even when the source seems reliable.
- EVERY claim must have a real source_url. If you cannot find a citable source, do not include the claim at all.
- Leadership claims are limited to a director/promoter's PROFESSIONAL, corporate-facing record only — role/title, tenure, other companies they direct, reported track record on those companies' projects. Never include personal-life details about a named individual (family, residence, personal history unrelated to their corporate role) even if a source reports them.
- For "legal_issue": only include this if you find an actual reported case, filing, or credible news report — never infer or guess based on company size or reputation.
- If you find nothing reliable about this company at all, return an empty claims array — do not pad with generic or inferred content.
- "rating" — a 0-10 score representing this developer's overall ability to deliver, in one of two forms:
  1. PREFERRED, when it exists: a real already-published rating/ranking for this exact company (a credible real-estate ratings platform, a reputable news ranking of builders, RERA standing expressed as a score). Convert to the 0-10 scale if the source uses a different one, keep source_url/source_title, and set "is_ai_assessment": false.
  2. Otherwise, IF you found at least one citable claim above: synthesize your own 0-10 assessment FROM ONLY those cited claims — weigh delivery history, financial condition, any legal issues, and leadership stability/track record. Also search for and weigh how this developer compares to other developers active in the same city and a similar project price segment, if you can find real information about comparable developers there — but the comparison only informs the number, it does not need its own separate citation. Set "is_ai_assessment": true and "basis" to a short (1-3 sentence) plain-English summary of which specific claims/facts the score weighs — someone reading "basis" should be able to see the number isn't arbitrary. Do NOT include source_url on this form (it has none by definition) and do NOT invent one.
  - If you found ZERO citable claims about this company at all, "rating" must be null — never synthesize a score with nothing behind it.
- "possession_record": delivered/total project counts ONLY from a real source that states them explicitly (e.g. RERA project registry showing completion status across the builder's registered projects, or credible reporting that gives exact figures) — NEVER count claims from your own "claims" array to derive these numbers, and never estimate. total must be >= delivered. If no such source exists, this must be null.
- Output ONLY the JSON object, no markdown code fences, no other text.`;

/**
 * Feature 2: Builder Due Diligence. Returns { claims, rating, possessionRecord,
 * citationCount } with every claim (and possessionRecord, if present)
 * guaranteed to carry a real citation (post-filter) — this is the FIRST of
 * three independent safeguards; see the migration for the second (NOT NULL /
 * CHECK source_url-or-basis constraints) and builderProfileController.js for
 * the third (human moderation gate before anything is public). `rating` is
 * grounded differently — see validateRating() below — since it can now be
 * either an external citation OR a synthesis of the claims above; either way
 * it's never accepted with nothing behind it.
 *
 * `marketContext` (optional) — city/locality + price band of whichever
 * listing triggered this research, if known — lets the model's comparison
 * step ("how does this developer compare to others in the same
 * city/price segment") be about a concrete market instead of a vague
 * national one. Purely additive context; research still runs fine without
 * it (e.g. re-research of an existing profile with no specific triggering
 * listing).
 */
async function generateBuilderClaims({ companyName, marketContext }) {
  const marketLine = marketContext
    ? ` For the comparison-to-other-developers part of your assessment, weigh this specifically against other developers building in ${marketContext}.`
    : '';
  const userPrompt = `Builder/developer company: "${companyName}" (India). Find real, cited information on: past project delivery history, ownership/board of directors (professional record only), financial condition, standing relative to other builders, any reported legal or criminal matters, a real published rating/ranking if one exists, and a real possession/delivery track record (projects delivered vs. total, from an authoritative source) if one is stated anywhere.${marketLine}`;

  const { text } = await callWebSearchGroundedGPT({
    systemPrompt: BUILDER_DD_SYSTEM_PROMPT,
    userPrompt,
  });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const parseError = new Error(`Builder Due Diligence: model output was not valid JSON: ${err.message}`);
    parseError.rawText = text;
    throw parseError;
  }

  const claims = filterCitedItems(parsed.claims).map((c) => ({
    category: c.category,
    claim_text: c.claim_text,
    source_url: c.source_url,
    source_title: c.source_title || null,
    source_domain: c.source_domain || (() => { try { return new URL(c.source_url).hostname; } catch { return null; } })(),
  }));

  const rating = validateRating(parsed.rating, claims.length);

  const possessionRaw = filterCitedSingle(parsed.possession_record);
  const possessionRecord = (
    possessionRaw
    && Number.isInteger(possessionRaw.delivered)
    && Number.isInteger(possessionRaw.total)
    && possessionRaw.delivered >= 0
    && possessionRaw.total >= possessionRaw.delivered
  )
    ? {
        delivered: possessionRaw.delivered,
        total: possessionRaw.total,
        source_url: possessionRaw.source_url,
        source_title: possessionRaw.source_title || null,
      }
    : null;

  return { claims, rating, possessionRecord, citationCount: claims.length, rawResponseText: text };
}

module.exports = {
  callWebSearchGroundedGPT,
  filterCitedItems,
  generateLocalIntelligence,
  generateBuilderClaims,
};
