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

const MAX_RESULTS = 8;

/**
 * Asks the model whether this text is an open-ended property search at
 * all (vs. a greeting, a reply to something else, spam, etc.) and, if so,
 * what it's looking for. Returns null when the model isn't confident this
 * is a search — callers should fall back to the existing single-listing
 * conversation flow in that case, exactly like before this feature
 * existed, rather than risk misfiring a "no properties found" reply to
 * something that was never a search.
 *
 * property_type and area are the only hard filters used downstream —
 * size (e.g. "200 gaz") is intentionally NOT filtered on in this version.
 * plot_area is a free-text field ("250 Sq Yards", "10 Marla") on listings,
 * so a strict numeric filter would silently drop real matches over unit
 * differences; size is only echoed back in the reply text so the buyer
 * can see what was searched for. A proper numeric plot-size column/filter
 * is a reasonable follow-up once there's real search volume to tune it
 * against.
 */
async function extractBuyerIntent(incomingText) {
  const systemPrompt = `You classify inbound WhatsApp messages to a real estate marketplace's shared number.
Decide if this message is an open-ended property search (buyer describing what they want to buy/rent) as opposed to a greeting, a reply to an existing conversation, spam, or anything else.

Respond with ONLY a JSON object, no other text:
{
  "is_property_search": boolean,
  "property_type": string or null,   // one of: Plot, House, Villa, Flat, Commercial, Agricultural Land, or null if unclear
  "area": string or null,            // locality/neighbourhood/road/city the buyer mentioned, in their own words
  "size_text": string or null        // any size the buyer mentioned, verbatim (e.g. "200 gaz", "3 bhk", "10 marla")
}

If is_property_search is false, set the other three fields to null.`;

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

    return {
      propertyType: parsed.property_type || null,
      area: parsed.area || null,
      sizeText: parsed.size_text || null,
    };
  } catch (err) {
    console.error('buyerSearchService: intent extraction failed (falling back to existing single-listing flow):', err.message);
    return null;
  }
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
async function findMatchingListings(knex, intent) {
  let query = knex('listings')
    .join('tenants', 'listings.tenant_id', 'tenants.id')
    .where('listings.status', 'active')
    .select(
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
    .orderBy('listings.created_at', 'desc')
    .limit(MAX_RESULTS);

  if (intent.propertyType) {
    query = query.whereRaw('LOWER(listings.property_type) = LOWER(?)', [intent.propertyType]);
  }

  if (intent.area) {
    query = query.where((builder) => {
      builder
        .whereRaw('listings.general_area ILIKE ?', [`%${intent.area}%`])
        .orWhereRaw('listings.formatted_address ILIKE ?', [`%${intent.area}%`])
        .orWhereRaw('listings.raw_address ILIKE ?', [`%${intent.area}%`]);
    });
  }

  return query;
}

function buildPublicListingUrl(publicSlug) {
  return `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/p/${publicSlug}`;
}

function formatPrice(price) {
  if (price == null) return 'Price on request';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(price);
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
    const what = [intent.propertyType, intent.area].filter(Boolean).join(' in ');
    return `Sorry, no matching properties found right now${what ? ` for "${what}"` : ''}. We'll keep an eye out — feel free to try a different area or property type.`;
  }

  const header = listings.length === 1
    ? 'Found 1 matching property:'
    : `Found ${listings.length} matching properties:`;

  const lines = listings.map((l, i) => {
    const area = l.general_area || 'Area on request';
    const size = l.plot_area ? ` · ${l.plot_area}` : '';
    return `${i + 1}. *${l.title}* — ${formatPrice(l.price)}${size}\n📍 ${area}\n${buildPublicListingUrl(l.public_slug)}`;
  });

  return `${header}\n\n${lines.join('\n\n')}\n\nTap a link to see more and connect directly with the dealer.`;
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
  const intent = await extractBuyerIntent(incomingText);
  if (!intent) return null;

  const listings = await findMatchingListings(knex, intent);
  await logDeliveries(knex, listings, buyerPhone, incomingText);

  return { replyText: formatSearchReply(listings, intent), matchCount: listings.length };
}

module.exports = { handleBuyerSearch };
