const axios = require('axios');
const jwt = require('jsonwebtoken');
const FormData = require('form-data');
const IORedis = require('ioredis');

/**
 * Integration with WayneRing (Wayneesolutions/aivoicebackend) — a separate,
 * already-working AI voice calling product from the same company, used here
 * instead of building telephony from scratch. Two real API constraints
 * shape everything in this file, confirmed by reading WayneRing's actual
 * code rather than assumed:
 *
 *   1. No service-account/API-key auth exists on WayneRing's side — only
 *      human tenant login (email+password -> JWT). Plotra logs in as a
 *      provisioned WayneRing tenant user and manages the token itself.
 *   2. No one-off "call this lead now" endpoint exists — outbound calling
 *      only happens through CSV-upload-driven campaigns. This is genuinely
 *      clunky for a single quiet-lead follow-up, but it's the real API, not
 *      a simplification chosen here.
 *
 * WayneRing also sends no outbound webhook — see wayneRingCallSyncWorker.js
 * for the polling side of this integration.
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

function buildSingleLeadCsv({ phone, name }) {
  const escapedName = `"${String(name || '').replace(/"/g, '""')}"`;
  return `phone,name\n${phone},${escapedName}\n`;
}

/**
 * Triggers an outbound AI follow-up call to one lead. Works within
 * WayneRing's real CSV-upload + campaign flow — there is no simpler
 * single-call endpoint to call instead. Not instant (subject to WayneRing's
 * own calling-hours gating) and returns no synchronous call ID, which is
 * why an anchor row is pre-inserted into Plotra's own ai_voice_calls table
 * here — wayneRingCallSyncWorker.js matches WayneRing's eventual call
 * record back to THIS row by phone + time window, since WayneRing's API has
 * no passthrough field for an external id.
 *
 * NOTE: the exact shape of the CSV-upload response (does it return a
 * `batchId`, or a `leads` array with generated ids?) was not confirmed
 * against live WayneRing traffic — this sandbox has no real WayneRing
 * credentials to test against. Coded defensively to try both; verify the
 * actual shape the first time this runs against a real WayneRing account
 * and simplify once confirmed.
 */
async function uploadLeadAndStartCampaign({ knex, tenantId, leadId, listingId, phone, name }) {
  const scriptId = process.env.WAYNERING_SCRIPT_ID;
  if (!scriptId) throw new Error('WAYNERING_SCRIPT_ID not configured — a Script must be created and approved in WayneRing\'s own dashboard first.');

  const csv = buildSingleLeadCsv({ phone, name });
  const form = new FormData();
  form.append('file', Buffer.from(csv, 'utf-8'), { filename: 'lead.csv', contentType: 'text/csv' });

  const uploadResponse = await authedRequest('post', '/api/leads/upload', {
    data: form,
    headers: form.getHeaders(),
  });

  const batchId = uploadResponse.data?.batchId;
  const uploadedLeadIds = Array.isArray(uploadResponse.data?.leads)
    ? uploadResponse.data.leads.map((l) => l.id).filter(Boolean)
    : [];

  const campaignScope = batchId
    ? { batchId }
    : uploadedLeadIds.length > 0
      ? { leadIds: uploadedLeadIds }
      : { includeAllLeads: false }; // last-resort — should not happen if upload succeeded; campaign will have nothing to dial rather than silently dialing unrelated leads

  const campaignResponse = await authedRequest('post', '/api/campaigns', {
    data: {
      name: `Plotra follow-up ${new Date().toISOString()}`,
      scriptId,
      callFromHour: 9,
      callToHour: 20,
      timezone: 'Asia/Kolkata',
      callDays: [1, 2, 3, 4, 5, 6, 7],
      maxAttempts: 1,
      retryAfterHours: 24,
      ...campaignScope,
    },
  });

  const campaignId = campaignResponse.data?.id;
  if (!campaignId) throw new Error('WayneRing campaign creation did not return an id.');

  await authedRequest('post', `/api/campaigns/${campaignId}/start`);

  // Anchor row — Plotra knows this phone number and timestamp; the sync
  // worker uses both to find the matching WayneRing call once it exists.
  const calledAt = new Date();
  await knex('ai_voice_calls').insert({
    tenant_id: tenantId,
    lead_id: leadId,
    listing_id: listingId || null,
    direction: 'outbound',
    provider: 'wayneRing',
    called_at: calledAt,
  });

  return { campaignId, calledAt };
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

module.exports = { getAuthToken, uploadLeadAndStartCampaign, listCalls, listInboundCalls };
