// Synchronous counterpart to the WhatsApp agent-intake flow
// (agentIntakeController.js / agentIntakeWorker.js). That flow is
// necessarily async (Meta webhook -> BullMQ -> reply dispatched back out
// through the WhatsApp Graph API), which a browser POST can't wait on.
// This endpoint calls the exact same extraction/listing-creation
// functions inline and returns the result in one request/response —
// same business logic, a synchronous transport in front of it.
//
// See BACKEND_API_SPEC.md for the frontend contract this implements.
const IORedis = require('ioredis');
const { createListingRecord, ListingLimitError } = require('../services/listingService');
const { extractListingFields, REQUIRED_FIELDS, FIELD_QUESTIONS } = require('../services/listingExtractionService');

// Same Redis instance BullMQ already connects to (see agentIntakeWorker.js) —
// no new infra, just a second logical use of it. maxRetriesPerRequest left at
// the ioredis default (unlike the BullMQ Worker connection, which needs
// `null` for its blocking commands) since this is plain GET/SET/DEL.
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redis = new IORedis({ host: REDIS_HOST, port: REDIS_PORT });

const SESSION_KEY_PREFIX = 'webchat:session:';
const SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 hours — plenty for a single demo/investor call or a real buyer inquiry

// Hard cap on accumulated conversation text per session. Bounds the cost of
// a single session's OpenAI calls (each call sends the whole accumulated
// string) and blocks the trivial abuse case of someone pasting huge blocks
// of text at the public endpoint repeatedly. ~500 words is far more than
// any real listing description needs.
const MAX_ACCUMULATED_CHARS = 4000;
const MAX_SESSION_ID_LENGTH = 128;

async function getSession(sessionId) {
  const raw = await redis.get(SESSION_KEY_PREFIX + sessionId);
  if (raw) return JSON.parse(raw);
  return { accumulatedText: '', listingId: null };
}

async function saveSession(sessionId, session) {
  await redis.set(SESSION_KEY_PREFIX + sessionId, JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
}

// No visitor login, and no natural tenant to attribute a web-chat-created
// listing to (there's no phone number to look up like the WhatsApp path
// has) — WEB_CHAT_TENANT_ID/WEB_CHAT_AGENT_USER_ID pin this explicitly to
// whichever tenant/user should own listings created through this endpoint
// (e.g. a dedicated demo tenant, or a real dealer's own web-chat widget).
//
// In production these are REQUIRED — silently guessing a tenant would mean
// a real buyer's listing gets created under whatever tenant happens to be
// oldest in the table, which is wrong in a way that's easy to miss. Local
// dev only: falls back to the oldest active tenant/user so it works
// out-of-the-box without extra setup, same fallback the buyer-inbound path
// in webhookController.js already uses.
async function resolveWebChatIdentity(knex) {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (!process.env.WEB_CHAT_TENANT_ID || !process.env.WEB_CHAT_AGENT_USER_ID) {
      const err = new Error('WEB_CHAT_TENANT_ID and WEB_CHAT_AGENT_USER_ID must both be set in production.');
      err.name = 'ConfigurationError';
      throw err;
    }
    const tenant = await knex('tenants').where({ id: process.env.WEB_CHAT_TENANT_ID, status: 'active' }).first();
    if (!tenant) {
      const err = new Error('WEB_CHAT_TENANT_ID does not match an active tenant.');
      err.name = 'ConfigurationError';
      throw err;
    }
    const user = await knex('users').where({ id: process.env.WEB_CHAT_AGENT_USER_ID, tenant_id: tenant.id }).first();
    if (!user) {
      const err = new Error('WEB_CHAT_AGENT_USER_ID does not match a user on WEB_CHAT_TENANT_ID.');
      err.name = 'ConfigurationError';
      throw err;
    }
    return { tenantId: tenant.id, createdBy: user.id };
  }

  // Dev fallback only.
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

function listingSummary(listing) {
  return { title: listing.title, address: listing.raw_address || listing.address };
}

async function handleWebChatMessage(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { message, session_id: sessionId } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'message is required.' } });
  }
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > MAX_SESSION_ID_LENGTH) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'session_id is required.' } });
  }
  if (message.length > MAX_ACCUMULATED_CHARS) {
    return res.status(400).json({ error: { code: 'MESSAGE_TOO_LONG', message: 'Message is too long.' } });
  }

  try {
    const identity = await resolveWebChatIdentity(knex);
    if (!identity) {
      return res.status(500).json({ error: { code: 'NO_TENANT', message: 'No tenant configured for web chat.' } });
    }

    const session = await getSession(sessionId);
    session.accumulatedText = (session.accumulatedText + ' ' + message.trim()).trim().slice(-MAX_ACCUMULATED_CHARS);

    // Listing already created earlier in this session — treat further
    // messages as a light correction pass rather than re-running the
    // whole missing-field question loop. Kept intentionally simple (no
    // re-geocode-on-address-change branch like the WhatsApp correction
    // path) since this doesn't need that depth.
    if (session.listingId) {
      const extracted = await extractListingFields(message.trim());
      const patch = {};
      if (extracted.title) patch.title = extracted.title.trim();
      if (extracted.raw_address) patch.raw_address = extracted.raw_address.trim();
      if (extracted.price) patch.price = parseFloat(extracted.price);
      if (extracted.plot_area) patch.plot_area = extracted.plot_area.trim();
      if (extracted.property_type) patch.property_type = extracted.property_type.trim();
      if (extracted.description) patch.description = extracted.description.trim();

      let listing = await knex('listings').where({ id: session.listingId, tenant_id: identity.tenantId }).first();
      if (!listing) {
        // Listing was deleted, or belongs to a different tenant than the
        // one currently configured (e.g. WEB_CHAT_TENANT_ID changed since
        // this session started) — don't silently patch across tenants.
        session.listingId = null;
        await saveSession(sessionId, session);
        return res.status(409).json({
          error: { code: 'LISTING_UNAVAILABLE', message: 'That listing is no longer available. Please start over.' },
        });
      }
      if (Object.keys(patch).length > 0) {
        patch.updated_at = knex.fn.now();
        await knex('listings').where({ id: session.listingId }).update(patch);
        listing = await knex('listings').where({ id: session.listingId }).first();
      }

      await saveSession(sessionId, session);
      return res.status(200).json({
        reply: "Updated! Anything else you'd like to add or change?",
        listing: listingSummary(listing),
      });
    }

    const extracted = await extractListingFields(session.accumulatedText);
    const missing = REQUIRED_FIELDS.filter((f) => !extracted[f]);

    if (missing.length > 0) {
      await saveSession(sessionId, session);
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
    await saveSession(sessionId, session);

    return res.status(200).json({
      reply: `Got it! I've mapped the address and created your listing — "${newListing.title}".`,
      listing: listingSummary({ title: newListing.title, raw_address: extracted.raw_address }),
    });

  } catch (error) {
    if (error instanceof ListingLimitError) {
      return res.status(200).json({ reply: error.message, listing: null });
    }
    if (error.name === 'ConfigurationError') {
      console.error('Web chat misconfigured:', error.message);
      return res.status(500).json({ error: { code: 'MISCONFIGURED', message: 'Web chat is not configured. Please try again later.' } });
    }
    console.error('Failed to process web chat message:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong processing that message.' } });
  }
}

module.exports = { handleWebChatMessage };
