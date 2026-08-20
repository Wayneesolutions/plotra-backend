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
  const fresh = { accumulatedText: '', listingId: null, touchedAt: Date.now() };
  sessions.set(sessionId, fresh);
  return fresh;
}

function listingSummary(listing) {
  return { title: listing.title, address: listing.raw_address || listing.address };
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
    session.accumulatedText = (session.accumulatedText + ' ' + message.trim()).trim();

    // Listing already created earlier in this session — treat further
    // messages as a light correction pass rather than re-running the
    // whole missing-field question loop. Kept intentionally simple (no
    // re-geocode-on-address-change branch like the WhatsApp correction
    // path) since a demo doesn't need that depth.
    if (session.listingId) {
      const extracted = await extractListingFields(message.trim());
      const patch = {};
      if (extracted.title) patch.title = extracted.title.trim();
      if (extracted.raw_address) patch.raw_address = extracted.raw_address.trim();
      if (extracted.price) patch.price = parseFloat(extracted.price);
      if (extracted.plot_area) patch.plot_area = extracted.plot_area.trim();
      if (extracted.property_type) patch.property_type = extracted.property_type.trim();
      if (extracted.description) patch.description = extracted.description.trim();

      let listing = await knex('listings').where({ id: session.listingId }).first();
      if (Object.keys(patch).length > 0) {
        patch.updated_at = knex.fn.now();
        await knex('listings').where({ id: session.listingId }).update(patch);
        listing = await knex('listings').where({ id: session.listingId }).first();
      }

      return res.status(200).json({
        reply: "Updated! Anything else you'd like to add or change?",
        listing: listingSummary(listing),
      });
    }

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

    return res.status(200).json({
      reply: `Got it! I've mapped the address and created your listing — "${newListing.title}".`,
      listing: listingSummary({ title: newListing.title, raw_address: extracted.raw_address }),
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
