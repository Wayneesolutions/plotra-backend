// Synchronous counterpart to the WhatsApp agent-intake flow
// (agentIntakeController.js / agentIntakeWorker.js). That flow is
// necessarily async (Meta webhook -> BullMQ -> reply dispatched back out
// through the WhatsApp Graph API), which a browser POST can't wait on.
// This endpoint calls the exact same extraction/listing-creation
// functions inline and returns the result in one request/response —
// same business logic, a synchronous transport in front of it.
//
// See BACKEND_API_SPEC.md for the frontend contract this implements.
const { createListingRecord, ListingLimitError } = require('../services/listingService');
const { extractListingFields, REQUIRED_FIELDS, FIELD_QUESTIONS } = require('../services/listingExtractionService');
const { isApprovalReply } = require('../utils/agentReplyIntent');

function buildPreviewLink(publicSlug) {
  return `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/p/${publicSlug}`;
}

// No visitor login, and no natural tenant to attribute a demo-created
// listing to (there's no phone number to look up like the WhatsApp path
// has) — WEB_CHAT_TENANT_ID/WEB_CHAT_AGENT_USER_ID let ops pin this
// explicitly (e.g. to a dedicated demo tenant). Undefined in dev, this
// falls back to the oldest active tenant/user, same fallback the
// buyer-inbound path in webhookController.js already uses.
async function resolveWebChatIdentity(knex) {
  let tenant;
  if (process.env.WEB_CHAT_TENANT_ID) {
    tenant = await knex('tenants').where({ id: process.env.WEB_CHAT_TENANT_ID, status: 'active' }).first();
  }
  if (!tenant) {
    tenant = await knex('tenants').where({ status: 'active' }).orderBy('created_at', 'asc').first();
  }
  if (!tenant) return null;

  let user;
  if (process.env.WEB_CHAT_AGENT_USER_ID) {
    user = await knex('users').where({ id: process.env.WEB_CHAT_AGENT_USER_ID, tenant_id: tenant.id }).first();
  }
  if (!user) {
    user = await knex('users').where({ tenant_id: tenant.id }).orderBy('created_at', 'asc').first();
  }
  if (!user) return null;

  return { tenantId: tenant.id, createdBy: user.id };
}

// Per-session accumulated text + the listing it produced, once created.
// In-memory only, same tradeoff the spec calls out for session_id in
// general: no login, short-lived, resets on process restart/redeploy.
// Fine for a public demo endpoint; would need a shared store (Redis) if
// this ever needs to survive across app instances.
const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — plenty for a single demo/investor call

function getSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing && Date.now() - existing.touchedAt < SESSION_TTL_MS) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const fresh = { accumulatedText: '', listingId: null, awaitingApproval: false, touchedAt: Date.now() };
  sessions.set(sessionId, fresh);
  return fresh;
}

function formatPrice(price) {
  const num = parseFloat(price);
  if (price === null || price === undefined || Number.isNaN(num)) return null;
  return '₹' + num.toLocaleString('en-IN');
}

// Accepts either a `listings` DB row (raw_address/plot_area/property_type)
// or an already-camelCase extracted-fields object — this is the one place
// that shape gets normalized before going out over the API. `publicSlug`
// is passed separately since a freshly-extracted-fields object won't have
// one yet at the point this is first called during creation.
function listingSummary(listing, publicSlug, published) {
  return {
    title: listing.title || null,
    address: listing.raw_address || listing.address || null,
    price: formatPrice(listing.price),
    plotArea: listing.plot_area || listing.plotArea || null,
    propertyType: listing.property_type || listing.propertyType || null,
    link: publicSlug ? buildPreviewLink(publicSlug) : null,
    published: !!published,
  };
}

// A message is an edit to the currently-tracked listing only if it doesn't
// name a different address. No address mentioned at all -> assume it's a
// correction/addition to the existing property (e.g. "actually make it 60
// lakh"). A *different* address mentioned -> a new, unrelated property, even
// though a listing already exists in this session.
function isSameProperty(existingListing, extracted) {
  if (!extracted.raw_address) return true;
  return extracted.raw_address.trim().toLowerCase() === (existingListing.raw_address || '').trim().toLowerCase();
}

async function handleWebChatMessage(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { message, session_id: sessionId } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'message is required.' } });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'session_id is required.' } });
  }

  try {
    const identity = await resolveWebChatIdentity(knex);
    if (!identity) {
      return res.status(500).json({ error: { code: 'NO_TENANT', message: 'No tenant configured for web chat demo.' } });
    }

    const session = getSession(sessionId);

    // Listing already created earlier in this session — check whether this
    // message is actually about that same property before treating it as an
    // edit. A different address means a brand-new listing, so the session
    // resets and falls through to the create path below exactly as if this
    // were the first message.
    if (session.listingId) {
      const existingListing = await knex('listings').where({ id: session.listingId }).first();

      // Approval reply takes priority over re-extraction — "haan"/"approve"
      // shouldn't get run through GPT extraction as if it were listing
      // details (it isn't; it has none, and extraction would just return
      // an all-null object, which is harmless, but there's no reason to
      // pay for the call when the intent is already unambiguous).
      if (session.awaitingApproval && isApprovalReply(message.trim())) {
        if (existingListing.status !== 'active') {
          await knex('listings').where({ id: session.listingId }).update({ status: 'active', updated_at: knex.fn.now() });
        }
        session.awaitingApproval = false;

        const listing = await knex('listings').where({ id: session.listingId }).first();
        return res.status(200).json({
          reply: `Live ho gaya! Yahan hai aapki listing ka link:\n${buildPreviewLink(listing.public_slug)}`,
          listing: listingSummary(listing, listing.public_slug, true),
        });
      }

      const extracted = await extractListingFields(message.trim());

      if (isSameProperty(existingListing, extracted)) {
        const patch = {};
        if (extracted.title) patch.title = extracted.title.trim();
        if (extracted.price) patch.price = parseFloat(extracted.price);
        if (extracted.plot_area) patch.plot_area = extracted.plot_area.trim();
        if (extracted.property_type) patch.property_type = extracted.property_type.trim();
        if (extracted.description) patch.description = extracted.description.trim();

        let listing = existingListing;
        if (Object.keys(patch).length > 0) {
          patch.updated_at = knex.fn.now();
          await knex('listings').where({ id: session.listingId }).update(patch);
          listing = await knex('listings').where({ id: session.listingId }).first();
        }

        const reply = session.awaitingApproval
          ? "Updated! Sahi hai to reply karo 'haan' ya 'approve' — publish ho jayegi. Kuch aur badalna hai to bata dijiye."
          : "Updated! Anything else you'd like to add or change?";

        return res.status(200).json({
          reply,
          listing: listingSummary(listing, listing.public_slug, listing.status === 'active'),
        });
      }

      // Different property — start over rather than folding this message's
      // details into the previous listing's accumulated text.
      session.listingId = null;
      session.awaitingApproval = false;
      session.accumulatedText = '';
    }

    session.accumulatedText = (session.accumulatedText + ' ' + message.trim()).trim();
    const extracted = await extractListingFields(session.accumulatedText);
    const missing = REQUIRED_FIELDS.filter((f) => !extracted[f]);

    if (missing.length > 0) {
      return res.status(200).json({
        reply: missing.map((f) => FIELD_QUESTIONS[f]).join(' '),
        listing: null,
      });
    }

    const newListing = await createListingRecord(knex, {
      tenantId: identity.tenantId,
      createdBy: identity.createdBy,
      source: 'web',
      title: extracted.title,
      rawAddress: extracted.raw_address,
      price: extracted.price,
      plotArea: extracted.plot_area,
      propertyType: extracted.property_type,
      description: extracted.description,
    });

    session.listingId = newListing.id;
    session.awaitingApproval = true;

    return res.status(200).json({
      reply: `Yeh raha aapki listing ka preview:\n${buildPreviewLink(newListing.public_slug)}\n\nSahi hai to reply karo "haan" ya "approve" — publish ho jayegi aur client ke saath share karne ke liye taiyaar hogi. Kuch badalna hai to naya detail bhej dijiye.`,
      listing: listingSummary({ ...extracted, title: newListing.title }, newListing.public_slug, false),
    });

  } catch (error) {
    if (error instanceof ListingLimitError) {
      return res.status(200).json({ reply: error.message, listing: null });
    }
    console.error('Failed to process web chat message:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong processing that message.' } });
  }
}

module.exports = { handleWebChatMessage };
