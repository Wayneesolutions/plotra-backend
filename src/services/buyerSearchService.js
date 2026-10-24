// src/services/buyerSearchService.js
//
// Powers the marketplace search flow: a buyer messaging the SHARED
// platform WhatsApp number (not any dealer's own registered number — see
// resolveTenantByReceivingNumber in webhookController.js) with an
// open-ended property request ("200 gaz plot ferozepur road") gets back
// links to every matching *active* listing across *every tenant* on the
// platform — not just one dealer's inventory.
//
// Scope reminder (do not expand without re-checking with the team):
// - Only wired up for the shared-number path in webhookController.js.
//   A dealer's own registered WhatsApp number is completely untouched —
//   this module is never called for that path.
// - No address is ever included in the reply — only listings.general_area
//   (locality-level, see locationResolutionService.js's extractGeneralArea)
//   plus the public listing link. The exact address stays behind the
//   dealer's own WhatsApp conversation, which the buyer reaches by
//   tapping the listing page's existing "Get full details on WhatsApp"
//   button (publicListingController.js / PropertyView.jsx) — unchanged by
//   this feature.
// - Every matched listing sent back is logged to
//   marketplace_lead_deliveries. This is Phase 1 (tracking only — see the
//   migration's comment) — no charging happens here. A dealer sharing
//   their own listing link never calls this module, so it can never be
//   logged/counted/charged as a marketplace-sourced lead.
const axios = require('axios');
const { formatInrShort } = require('../utils/money');
const { looksLikeSellerIntent } = require('../utils/sellerIntent');

const MAX_RESULTS = 8;
const parsePrice = (...a) => require('../utils/visitorFlowParsers').parsePrice(...a);

/**
 * Asks the model whether this text is an open-ended property search at
 * all (vs. a greeting, a reply to something else, spam, etc.) and, if so,
 * what it's looking for. Returns null when the model isn't confident this
 * is a search — callers should fall back to the existing single-listing
 * conversation flow in that case, exactly like before this feature
 * existed, rather than risk misfiring a "no properties found" reply to
 * something that was never a search.
 *
 * property_type and area are SQL filters. Size ("200 gaj", "10 marla") is
 * applied afterwards in code (see parsePlotSize / sizeMatches): plot_area is
 * free text on listings ("250 Sq Yards", "10 Marla"), so both sides are
 * converted to square yards before comparing, which keeps unit differences
 * ("gaj" vs "sq yd") from dropping real matches.
 */
async function extractBuyerIntent(incomingText) {
  const systemPrompt = `You classify inbound WhatsApp messages to a real estate marketplace's shared number.
Decide if this message is an open-ended property search (buyer describing what they want to buy/rent) as opposed to a greeting, a reply to an existing conversation, spam, or anything else.

Respond with ONLY a JSON object, no other text:
{
  "is_property_search": boolean,
  "property_type": string or null,   // one of: Plot, House, Villa, Flat, Commercial, Agricultural Land, or null if unclear
  "area": string or null,            // locality/neighbourhood/road/city the buyer mentioned, in their own words
  "size_text": string or null,       // any size the buyer mentioned, verbatim (e.g. "200 gaz", "3 bhk", "10 marla")
  "budget_text": string or null      // the buyer's budget / max price, verbatim (e.g. "50 lakh", "1.5 cr"), or null
}

Someone who wants to SELL their own property ("want to sell", "bechna hai", "vechni hai") is NOT a property search: set is_property_search to false.
If is_property_search is false, set the other fields to null.`;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: incomingText },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 10000,
    });

    const parsed = JSON.parse(response.data.choices[0].message.content);

    // Require at least a property_type OR an area — a search with neither
    // (model said is_property_search but couldn't pin down what/where)
    // isn't specific enough to match against, and matching every active
    // listing on the platform against nothing would be noise, not a
    // search result.
    if (!parsed.is_property_search || (!parsed.property_type && !parsed.area)) {
      return null;
    }

    const budget = parsed.budget_text ? parsePrice(parsed.budget_text) : parsePrice(incomingText);
    return {
      propertyType: parsed.property_type || null,
      area: parsed.area || null,
      sizeText: parsed.size_text || null,
      budgetInr: budget?.inr || null,
    };
  } catch (err) {
    console.error('buyerSearchService: intent extraction failed (falling back to existing single-listing flow):', err.message);
    return null;
  }
}


// ---------------------------------------------------------------- plot size

// Square yards per unit. gaj/gaz are the same as a square yard; a Punjab marla
// is 272.25 sq ft (30.25 sq yd) and a kanal is 20 marla. BHK is a flat size,
// not a plot area, so it never parses.
const SQ_YD_PER_UNIT = [
  [/^(?:gaj|gaz|gajj|sq\.?\s*y(?:ar)?d?s?|square\s*y(?:ar)?d?s?|yards?|yds?)$/i, 1],
  [/^(?:sq\.?\s*f(?:ee)?t\.?|sqft|square\s*f(?:ee)?t)$/i, 1 / 9],
  [/^(?:marla|marle)$/i, 30.25],
  [/^(?:kanal|kanaal)$/i, 605],
];
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(gaj|gaz|gajj|sq\.?\s*y(?:ar)?d?s?|square\s*y(?:ar)?d?s?|yards?|yds?|sq\.?\s*f(?:ee)?t\.?|sqft|square\s*f(?:ee)?t|marla|marle|kanal|kanaal)\b/i;
const SIZE_TOLERANCE = 0.1; // listings say "200" for 195-210 yard plots

/** Pure (unit-tested): "200 gaj" / "10 Marla" / "1200 sq ft" -> square yards, or null. */
function parsePlotSize(text) {
  const m = String(text || '').match(SIZE_RE);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = SQ_YD_PER_UNIT.find(([re]) => re.test(m[2].trim()));
  return unit ? value * unit[1] : null;
}

/**
 * Pure (unit-tested): 'match' / 'mismatch' / 'unknown' for one listing. A
 * listing whose size can't be read is 'unknown' (kept, after the matches),
 * never silently treated as a match.
 */
function sizeMatches(wantedText, listingText) {
  const wanted = parsePlotSize(wantedText);
  if (!wanted) return 'match'; // nothing (parseable) was asked for
  const have = parsePlotSize(listingText);
  if (!have) return 'unknown';
  return Math.abs(have - wanted) / wanted <= SIZE_TOLERANCE ? 'match' : 'mismatch';
}

/** Pure: keeps matching sizes first, then unknown ones; drops known mismatches. */
function filterBySize(listings, sizeText) {
  if (!parsePlotSize(sizeText)) return listings;
  const verdicts = listings.map((l) => ({ l, v: sizeMatches(sizeText, l.plot_area) }));
  return [...verdicts.filter((x) => x.v === 'match'), ...verdicts.filter((x) => x.v === 'unknown')].map((x) => x.l);
}

/**
 * Cross-tenant match — deliberately no tenant_id filter. status='active'
 * only (never a pending/awaiting-approval/geo-review listing — those
 * haven't been through the pin checks this platform now requires before
 * anything goes live). Matches on property_type (exact, case-insensitive)
 * AND area (loose ILIKE against general_area — falls back to
 * formatted_address/raw_address for listings from before this feature,
 * since general_area is NULL on those — see the migration). Either filter
 * is skipped if the buyer didn't mention it.
 */
async function findMatchingListings(knex, intent, { tenantId } = {}) {
  let query = knex('listings')
    .join('tenants', 'listings.tenant_id', 'tenants.id')
    // Locality Master match (from the dealer's own address text): the most
    // reliable area name to show, see displayArea().
    .leftJoin('localities as loc', 'listings.locality_id', 'loc.id')
    .where('listings.status', 'active')
    .select(
      'loc.name as locality_name',
      'loc.city as locality_city',
      'listings.id',
      'listings.title',
      'listings.price',
      'listings.property_type',
      'listings.plot_area',
      'listings.general_area',
      'listings.formatted_address',
      'listings.raw_address',
      'listings.public_slug',
      'listings.tenant_id'
    )
    // Listings with a price first, "price on request" after them (23 Oct).
    .orderByRaw('(listings.price IS NULL) ASC')
    .orderBy('listings.created_at', 'desc')
    // With a size to apply, over-fetch: most rows are filtered out in code.
    .limit(parsePlotSize(intent.sizeText) ? MAX_RESULTS * 12 : MAX_RESULTS);

  // Optional single-dealer scope — used by callEnquiryService.js for a call
  // that came in on a dealer's own AI-calling number. The WhatsApp
  // marketplace search above never passes this and stays cross-tenant.
  if (tenantId) {
    query = query.where('listings.tenant_id', tenantId);
  }

  // One type or several ("1, 2, 3" in the buyer flow). Kothi/house are
  // stored as Villa or House, so asking for either finds both.
  const types = expandTypes(intent.propertyTypes?.length ? intent.propertyTypes : (intent.propertyType ? [intent.propertyType] : []));
  if (types.length) {
    query = query.whereRaw(`LOWER(listings.property_type) IN (${types.map(() => '?').join(', ')})`, types);
  }

  // Budget is a MAX: a listing above it is never sent (23 Oct bug: a ₹2.7
  // crore plot came back for a ₹50 lakh budget). Small margin for
  // negotiation. "Price on request" listings are kept, after the priced ones.
  if (intent.budgetInr) {
    query = query.where((b) => b.whereNull('listings.price').orWhere('listings.price', '<=', Math.round(intent.budgetInr * BUDGET_MARGIN)));
  }

  if (intent.area) {
    query = query.where((builder) => {
      builder
        .whereRaw('listings.general_area ILIKE ?', [`%${intent.area}%`])
        .orWhereRaw('listings.formatted_address ILIKE ?', [`%${intent.area}%`])
        .orWhereRaw('listings.raw_address ILIKE ?', [`%${intent.area}%`]);
    });
  }

  const rows = await query;
  return filterBySize(rows, intent.sizeText).slice(0, MAX_RESULTS);
}

function buildPublicListingUrl(publicSlug) {
  return `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/p/${publicSlug}`;
}

/** "₹50 lakh" / "₹2.7 crore" (not "₹50,00,000"); "Price on request" when unknown. */
function formatPrice(price) {
  return formatInrShort(price) || 'Price on request';
}

const BUDGET_MARGIN = 1.1;

const TYPE_ALIASES = { villa: ['villa', 'house'], house: ['house', 'villa'], plot: ['plot'], flat: ['flat'], commercial: ['commercial'], 'agricultural land': ['agricultural land', 'plot'] };
function expandTypes(list) {
  const out = [];
  for (const t of list) {
    const k = String(t || '').trim().toLowerCase();
    if (!k) continue;
    for (const v of (TYPE_ALIASES[k] || [k])) if (!out.includes(v)) out.push(v);
  }
  return out;
}

// Size units a listing can show. Anything else ("100 PLYORD SQ") is not shown
// rather than sent as garbage (23 Oct).
const DISPLAY_UNITS = [
  [/^(?:gaj|gaz|gajj)$/i, 'gaj'],
  [/^(?:sq\.?\s*y(?:ar)?ds?|sq\.?\s*yd|sqyds?|square\s*y(?:ar)?ds?|yards?|yds?)$/i, 'sq yd'],
  [/^(?:sq\.?\s*f(?:ee)?t\.?|sqft|square\s*f(?:ee)?t|sft)$/i, 'sq ft'],
  [/^(?:marla|marle|marlas)$/i, 'marla'],
  [/^(?:kanal|kanaal|kanals)$/i, 'kanal'],
  [/^(?:acres?|killa|kille)$/i, 'acre'],
  [/^(?:bigha|bighas)$/i, 'bigha'],
  [/^bhk$/i, 'BHK'],
];
const DISPLAY_SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(gaj|gaz|gajj|sq\.?\s*y(?:ar)?ds?|sq\.?\s*yd|sqyds?|square\s*y(?:ar)?ds?|yards?|yds?|sq\.?\s*f(?:ee)?t\.?|sqft|square\s*f(?:ee)?t|sft|marlas?|marle|kanals?|kanaal|acres?|killa|kille|bighas?|bhk)(?![a-z])/i;

/** Pure: "250 Sq Yards" -> "250 sq yd", "10 Marla" -> "10 marla", "100 PLYORD SQ" -> null. */
function displaySize(plotArea) {
  const m = String(plotArea || '').match(DISPLAY_SIZE_RE);
  if (!m) return null;
  const unit = DISPLAY_UNITS.find(([re]) => re.test(m[2].replace(/\s+/g, ' ').trim()));
  if (!unit) return null;
  const num = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) return null;
  return `${num.toLocaleString('en-IN')} ${unit[1]}`;
}

const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9\u0900-\u0a7f]+/g, ' ').trim();
/** The place named in a title like "Plot in Dasmesh Nagar" / "Kothi at Model Town, Ludhiana". */
function titleArea(title) {
  const m = String(title || '').match(/\b(?:in|at|near|on)\s+(.+)$/i);
  return m ? m[1].replace(/[.!]+$/, '').trim() : null;
}

/**
 * Pure: the area line for one result. The Locality Master match (from the
 * dealer's own address) wins; the geocoded general_area is used only when it
 * agrees with what the dealer wrote, so the title and the area never
 * contradict each other (23 Oct bug: "Plot in Dasmesh Nagar" showed
 * "Industrial Area-B"). Never the exact address.
 */
function displayArea(l) {
  if (l.locality_name) return [l.locality_name, l.locality_city].filter(Boolean).join(', ');
  const fromTitle = titleArea(l.title);
  const general = l.general_area || null;
  if (general && fromTitle) {
    const g = norm(general.split(',')[0]);
    const tt = norm(fromTitle);
    if (g && (tt.includes(g) || g.includes(tt.split(',')[0]))) return general;
    return fromTitle;
  }
  return general || fromTitle || 'Area on request';
}

/**
 * Builds the WhatsApp reply text — title, price, general area (never the
 * exact address), and the link. Each link is that listing's own dealer's
 * shareable page — tapping it and then the page's own WhatsApp button is
 * how the buyer reaches that specific dealer, same flow as any other
 * shared listing link, untouched by this feature.
 */
function formatSearchReply(listings, intent) {
  if (listings.length === 0) {
    const what = [intent.sizeText, intent.propertyType, intent.area].filter(Boolean).join(' · ');
    return `Sorry, no matching properties found right now${what ? ` for "${what}"` : ''}. We'll keep an eye out — feel free to try a different area or property type.`;
  }

  const header = listings.length === 1
    ? 'Found 1 matching property:'
    : `Found ${listings.length} matching properties:`;

  // Priced listings first; "price on request" ones in their own block after.
  const priced = listings.filter((l) => l.price != null);
  const onRequest = listings.filter((l) => l.price == null);
  let n = 0;
  const line = (l) => {
    n += 1;
    const size = displaySize(l.plot_area);
    const price = l.price != null ? ` — ${formatPrice(l.price)}` : '';
    return `${n}. *${l.title}*${price}${size ? ` · ${size}` : ''}\n📍 ${displayArea(l)}\n${buildPublicListingUrl(l.public_slug)}`;
  };
  const blocks = [];
  if (priced.length) blocks.push(priced.map(line).join('\n\n'));
  if (onRequest.length) blocks.push(`${priced.length ? '*Price on request:*\n\n' : '*Price on request* (ask the dealer):\n\n'}${onRequest.map(line).join('\n\n')}`);

  return `${header}\n\n${blocks.join('\n\n')}\n\nTap a link to see more and connect directly with the dealer.`;
}

/**
 * Logs one row per listing actually sent back to the buyer — the only
 * source of truth for marketplace-sourced lead counts (Phase 2 billing
 * reads from this table; nothing else does). Best-effort: a logging
 * failure shouldn't block the reply the buyer is waiting on, so this
 * never throws — it just logs to console and moves on.
 */
async function logDeliveries(knex, listings, buyerPhone, matchedQuery) {
  if (listings.length === 0) return;

  try {
    await knex('marketplace_lead_deliveries').insert(
      listings.map((l) => ({
        tenant_id: l.tenant_id,
        listing_id: l.id,
        buyer_phone: buyerPhone,
        matched_query: matchedQuery,
      }))
    );
  } catch (err) {
    console.error('buyerSearchService: failed to log marketplace lead deliveries (non-fatal):', err.message);
  }
}

/**
 * Entry point called from webhookController.js. Returns null if this
 * wasn't a confident property search (caller should fall back to the
 * existing flow), or { replyText } once it's been handled — matches (if
 * any) already logged to marketplace_lead_deliveries.
 */
async function handleBuyerSearch(knex, { incomingText, buyerPhone }) {
  // Someone selling is never searched for (23 Oct): the caller sends them
  // the sell-property link instead.
  if (looksLikeSellerIntent(incomingText)) return null;
  const intent = await extractBuyerIntent(incomingText);
  if (!intent) return null;

  const listings = await findMatchingListings(knex, intent);
  await logDeliveries(knex, listings, buyerPhone, incomingText);

  return { replyText: formatSearchReply(listings, intent), matchCount: listings.length };
}

module.exports = {
  parsePlotSize, sizeMatches, filterBySize, handleBuyerSearch, extractBuyerIntent, findMatchingListings, formatSearchReply, logDeliveries, formatPrice, buildPublicListingUrl,
  displaySize, displayArea, expandTypes, BUDGET_MARGIN,
};
