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
 * single nullable object (rating / possession record) rather than an array
 * — generateBuilderClaims() below returns these as at-most-one values, not
 * lists. Returns null if the item itself is null/malformed or its
 * source_url isn't a real URL — never a half-populated object with a
 * number but no citation.
 */
function filterCitedSingle(item) {
  if (!item || typeof item !== 'object') return null;
  if (!isValidHttpUrl(item.source_url)) return null;
  return item;
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

const BUILDER_DD_SYSTEM_PROMPT = `You research real, publicly-verifiable information about an Indian real-estate developer/builder company, for a buyer-facing due-diligence summary. This is legally sensitive: false claims about a real company or its named owners/directors is a defamation risk. You MUST use the web_search tool and cite every single claim to a real source.

Prioritize authoritative sources: RERA (India's Real Estate Regulatory Authority) state registries for project registration/delivery history, MCA (Ministry of Corporate Affairs) filings for company/director information, court records, and credible news outlets. Do not rely on the builder's own marketing materials as a sole source for delivery-history or financial claims.

Return ONLY a JSON object with exactly these keys:
{
  "claims": [ { "category": "delivery_history" | "leadership" | "financial_condition" | "rating" | "legal_issue", "claim_text": string, "source_url": string, "source_title": string, "source_domain": string }, ... ],
  "rating": { "value": number, "source_url": string, "source_title": string } | null,
  "possession_record": { "delivered": number, "total": number, "source_url": string, "source_title": string } | null
}

Rules:
- Phrase every claim_text as attributed reporting, e.g. "Reported by [source] that..." or "According to RERA filings,..." — NEVER as a flat assertion of fact, even when the source seems reliable.
- EVERY claim must have a real source_url. If you cannot find a citable source, do not include the claim at all.
- For "legal_issue": only include this if you find an actual reported case, filing, or credible news report — never infer or guess based on company size or reputation.
- If you find nothing reliable about this company at all, return an empty claims array — do not pad with generic or inferred content.
- "rating": a numeric score (out of 5) ONLY if a real published rating/ranking exists for this exact company (e.g. a credible real-estate ratings platform, a reputable news ranking of builders, RERA standing where it's expressed as a score). NEVER compute or infer a rating yourself from the claims you found, and never estimate one from company size, reputation, or general impression — if no real published numeric rating exists, this must be null. Convert to a 0-5 scale if the source uses a different scale, and say so in source_title.
- "possession_record": delivered/total project counts ONLY from a real source that states them explicitly (e.g. RERA project registry showing completion status across the builder's registered projects, or credible reporting that gives exact figures) — NEVER count claims from your own "claims" array to derive these numbers, and never estimate. total must be >= delivered. If no such source exists, this must be null.
- Output ONLY the JSON object, no markdown code fences, no other text.`;

/**
 * Feature 2: Builder Due Diligence. Returns { claims, rating, possessionRecord,
 * citationCount } with every claim (and rating/possessionRecord, if present)
 * guaranteed to carry a real citation (post-filter) — this is the FIRST of
 * three independent safeguards; see the migration for the second (NOT NULL /
 * CHECK source_url constraints) and builderProfileController.js for the
 * third (human moderation gate before anything is public).
 */
async function generateBuilderClaims({ companyName }) {
  const userPrompt = `Builder/developer company: "${companyName}" (India). Find real, cited information on: past project delivery history, ownership/board of directors, financial condition, standing relative to other builders, any reported legal or criminal matters, a real published rating/ranking if one exists, and a real possession/delivery track record (projects delivered vs. total, from an authoritative source) if one is stated anywhere.`;

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

  const ratingRaw = filterCitedSingle(parsed.rating);
  const rating = (ratingRaw && Number.isFinite(Number(ratingRaw.value)))
    ? {
        value: Math.max(0, Math.min(5, Number(ratingRaw.value))),
        source_url: ratingRaw.source_url,
        source_title: ratingRaw.source_title || null,
      }
    : null;

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
