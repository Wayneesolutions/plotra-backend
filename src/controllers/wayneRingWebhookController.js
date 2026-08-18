// src/controllers/wayneRingWebhookController.js
//
// Receiver for WayneRing's (aivoicebackend) outbound call.completed webhook
// (aivoicebackend PR #5, src/services/outboundWebhook.js on that side) —
// the follow-up flagged as not-yet-done in PLOTRA_HANDOVER_FOR_SANT.md
// §10.8: "Add that receiving route on the Plotra side, verify the HMAC
// signature ..., and use it to reduce wayneRingCallSyncWorker.js's poll
// interval or retire polling entirely — polling should stay on as a
// fallback for at least one full release cycle even after the webhook is
// wired, in case delivery silently fails for a tenant."
//
// This does NOT trust the webhook payload's own outcome fields directly —
// it uses the payload only to know a call finished and which direction, then
// re-runs the same syncOutboundCalls/syncInboundCalls correlation the
// poller already uses (src/services/wayneRingSyncService.js). That keeps
// exactly one tested code path responsible for writing ai_voice_calls /
// wayne_ring_unmatched_calls, instead of a second, parallel implementation
// that could quietly drift from it.
//
// Manual setup still required before this fires for real: log in as
// Plotra's WayneRing tenant and call WayneRing's PATCH /api/tenant/webhook
// with this route's public URL (POST /api/v1/webhooks/wayne-ring) + a
// shared secret, then POST /api/tenant/webhook/test to confirm delivery —
// see §10.8's "What Plotra still needs to do".
const crypto = require('crypto');
const { syncOutboundCalls, syncInboundCalls } = require('../services/wayneRingSyncService');

/**
 * Verifies WayneRing's HMAC signature against the RAW request body bytes —
 * same rationale/pattern as webhookController.js's isValidSignature for the
 * WhatsApp BSP: re-stringifying req.body can't reliably reproduce the exact
 * bytes WayneRing signed. Requires req.rawBody (captured globally by
 * express.json()'s verify option in app.js).
 *
 * Matches outboundWebhook.js's signBody on the WayneRing side exactly:
 * crypto.createHmac('sha256', secret).update(bodyStr).digest('hex') — no
 * "sha256=" prefix, unlike the WhatsApp/Meta-style signature elsewhere in
 * this codebase.
 */
function isValidSignature(req, secret) {
  const signature = req.headers['x-vocallm-signature'];
  if (!secret) return true; // no secret configured yet — nothing to check against (dev mode, same convention as Stripe/WhatsApp)
  if (!signature || !req.rawBody) return false;

  const digest = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false; // length mismatch etc. — treat as invalid, not a crash
  }
}

/**
 * POST /api/v1/webhooks/wayne-ring
 * Public — HMAC-verified via WAYNERING_WEBHOOK_SECRET, same access model as
 * the Stripe/WhatsApp webhook routes (an external system can't send a
 * Bearer token; the signature is the real gate here, not tenant matching —
 * hence no serviceContext middleware on this route: syncOutboundCalls/
 * syncInboundCalls already open their own service-context transaction).
 *
 * Always acks 200, even when the resync itself errors or the event is one
 * we don't act on — WayneRing's own sender only retries twice
 * (outboundWebhook.js, MAX_ATTEMPTS=2) before dropping the event with "no
 * queue/DLQ in v1", and the poller remains the fallback net regardless, so
 * there is nothing productive a non-200 here would cause WayneRing to do
 * differently.
 */
async function handleWayneRingWebhook(req, res) {
  const secret = process.env.WAYNERING_WEBHOOK_SECRET;

  if (!isValidSignature(req, secret)) {
    console.warn('[wayneRingWebhook] Rejected — invalid or missing signature.');
    return res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed.' } });
  }

  const { event, data } = req.body || {};

  if (event !== 'call.completed') {
    return res.status(200).json({ received: true, ignored: true });
  }

  const knex = req.app.get('db');
  const direction = data?.direction;

  try {
    if (direction === 'outbound') {
      const result = await syncOutboundCalls(knex);
      console.log(`[wayneRingWebhook] call.completed (outbound, providerCallId=${data?.providerCallId}) — resync: ${JSON.stringify(result)}`);
    } else if (direction === 'inbound') {
      const result = await syncInboundCalls(knex);
      console.log(`[wayneRingWebhook] call.completed (inbound, providerCallId=${data?.providerCallId}) — resync: ${JSON.stringify(result)}`);
    } else {
      // Unrecognized/missing direction — resync both rather than drop the
      // event silently. Cheap: these are no-ops when nothing is pending.
      const [outboundResult, inboundResult] = await Promise.all([syncOutboundCalls(knex), syncInboundCalls(knex)]);
      console.log(`[wayneRingWebhook] call.completed (direction unknown) — outbound: ${JSON.stringify(outboundResult)}, inbound: ${JSON.stringify(inboundResult)}`);
    }
  } catch (error) {
    // Log and still 200 — see function header. The next poll tick (or the
    // next webhook delivery) will pick up whatever this attempt missed.
    console.error('[wayneRingWebhook] resync failed:', error.message);
  }

  return res.status(200).json({ received: true });
}

module.exports = { handleWayneRingWebhook };
