const axios = require('axios');
const jwt = require('jsonwebtoken');
const IORedis = require('ioredis');

/**
 * Integration with WayneRing (Wayneesolutions/aivoicebackend) — a separate,
 * already-working AI voice calling product from the same company, used here
 * instead of building telephony from scratch.
 *
 *   1. No service-account/API-key auth exists on WayneRing's side — only
 *      human tenant login (email+password -> JWT). Plotra logs in as a
 *      provisioned WayneRing tenant user and manages the token itself.
 *      Still true — no fix available for this one.
 *   2. Outbound calls now go through WayneRing's POST /api/leads/call
 *      (aivoicebackend PR #5, 2026-08-17) — a real one-off "call this lead
 *      now" endpoint that returns a call id synchronously. Before PR #5,
 *      this file had to fake it via CSV-upload + campaign-create + start
 *      for a single lead; that flow is gone from here now that the real
 *      endpoint exists. Requires WayneRing's PR #5 to be merged and
 *      deployed — this integration will 404 against an older WayneRing
 *      deployment that predates it.
 *
 * WayneRing added an outbound webhook in that same PR — Plotra now has a
 * receiver for it (src/controllers/wayneRingWebhookController.js, POST
 * /api/v1/webhooks/wayne-ring). wayneRingCallSyncWorker.js still polls too,
 * deliberately kept as a fallback (PLOTRA_HANDOVER_FOR_SANT.md §10.8).
 * Still needs, on WayneRing's side: PATCH /api/tenant/webhook with this
 * route's URL + a shared secret (WAYNERING_WEBHOOK_SECRET here), then
 * POST /api/tenant/webhook/test to confirm delivery.
 */

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const redis = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 3000 });

const JWT_CACHE_KEY = 'wayneRing:jwt';
const BASE_URL = process.env.WAYNERING_BASE_URL; // e.g. https://api.wayneesolutions-aivoice.example
const TOKEN_EXPIRY_BUFFER_SECONDS = 5 * 60; // refresh 5 min before real expiry, not exactly at it

/**
 * Returns a valid WayneRing JWT, cached in Redis (not in-process — Plotra
 * runs multiple worker processes, e.g. worker:geo/worker:vocallm/etc. per
 * package.json's "workers" script; an in-process cache would mean each one
 * holds its own separate WayneRing session for no reason).
 */
async function getAuthToken() {
  const cached = await redis.get(JWT_CACHE_KEY);
  if (cached) return cached;

  if (!BASE_URL || !process.env.WAYNERING_EMAIL || !process.env.WAYNERING_PASSWORD) {
    throw new Error('WayneRing credentials not configured (WAYNERING_BASE_URL/EMAIL/PASSWORD).');
  }

  const response = await axios.post(`${BASE_URL}/api/auth/tenant/login`, {
    email: process.env.WAYNERING_EMAIL,
    password: process.env.WAYNERING_PASSWORD,
  }, { timeout: 15000 });

  const token = response.data?.token || response.data?.accessToken;
  if (!token) throw new Error('WayneRing login response did not include a token.');

  // Decode (not verify — we're a client, not the issuer, and don't have
  // WayneRing's JWT_SECRET) purely to read the real exp claim rather than
  // guessing a TTL.
  const decoded = jwt.decode(token);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = decoded?.exp
    ? Math.max(decoded.exp - nowSeconds - TOKEN_EXPIRY_BUFFER_SECONDS, 60)
    : 60 * 60; // fallback if the token is somehow unreadable — short, forces a re-login soon rather than caching indefinitely

  await redis.set(JWT_CACHE_KEY, token, 'EX', ttlSeconds);
  return token;
}

async function authedRequest(method, path, options = {}) {
  const token = await getAuthToken();
  const { headers: callerHeaders, timeout, ...restOptions } = options;
  return axios({
    method,
    url: `${BASE_URL}${path}`,
    timeout: timeout || 20000,
    ...restOptions,
    // Merged last, deliberately — restOptions must never be able to clobber
    // the Authorization header the way a trailing ...options spread would
    // (found and fixed during implementation: passing a caller-supplied
    // `headers` option, e.g. the CSV upload's multipart boundary header,
    // previously overwrote this object outright and silently dropped auth).
    headers: { Authorization: `Bearer ${token}`, ...(callerHeaders || {}) },
  });
}

/**
 * Places a single outbound AI call to one lead right now, via WayneRing's
 * POST /api/leads/call (aivoicebackend PR #5). Unlike the CSV/campaign
 * detour this replaces, WayneRing returns its own call id synchronously —
 * so the anchor row inserted here already carries provider_call_id, and
 * wayneRingCallSyncWorker.js's poll can match it exactly instead of
 * guessing by phone + time window. The call itself still isn't instant to
 * *complete* (ringing/talking takes real time, and WayneRing still applies
 * its own calling-hours logic per script/campaign defaults), just instant
 * to *place* — the caller gets a real WayneRing call id back immediately.
 */
async function callLeadNow({ knex, tenantId, leadId, listingId, phone, name }) {
  const scriptId = process.env.WAYNERING_SCRIPT_ID;
  if (!scriptId) throw new Error('WAYNERING_SCRIPT_ID not configured — a Script must be created and approved in WayneRing\'s own dashboard first.');

  const response = await authedRequest('post', '/api/leads/call', {
    data: { scriptId, phone, name, country: 'IN' },
  });

  const { callId, vapiCallId } = response.data || {};
  if (!callId) throw new Error('WayneRing did not return a callId for the call it placed.');

  const calledAt = new Date();
  await knex('ai_voice_calls').insert({
    tenant_id: tenantId,
    lead_id: leadId,
    listing_id: listingId || null,
    direction: 'outbound',
    provider: 'wayneRing',
    called_at: calledAt,
    provider_call_id: callId, // known synchronously — no phone/time matching needed for this row
  });

  return { callId, vapiCallId, calledAt };
}

async function listCalls({ since } = {}) {
  const response = await authedRequest('get', '/api/calls', {
    params: since ? { since: since.toISOString() } : undefined,
  });
  return response.data?.calls || response.data || [];
}

async function listInboundCalls({ since } = {}) {
  const response = await authedRequest('get', '/api/inbound/calls', {
    params: since ? { since: since.toISOString() } : undefined,
  });
  return response.data?.calls || response.data || [];
}

module.exports = { getAuthToken, callLeadNow, listCalls, listInboundCalls };
