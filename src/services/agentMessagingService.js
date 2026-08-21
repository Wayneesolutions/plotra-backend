const { Queue } = require('bullmq');
const { detectReplyLanguage } = require('../utils/replyLanguage');

// Same fail-fast producer config used throughout (webhookController.js,
// listingService.js) — this is called from request/job handlers, not a
// worker, so a Redis blip should fail fast rather than hang the caller.
const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  connectTimeout: 3000,
};
const whatsappOutboundQueue = new Queue('whatsapp-outbound', { connection: redisConnection });

/**
 * Records an outbound agent-intake message in the transcript. Call this
 * INSIDE the same transaction as whatever DB state change triggered the
 * send (e.g. flipping a draft to awaiting_approval) — logging is part of
 * the atomic state change, not a side effect of delivery.
 */
async function logAgentOutboundMessage(trx, { draftId, body }) {
  await trx('agent_draft_messages').insert({
    draft_id: draftId,
    direction: 'outbound',
    body,
  });
}

/**
 * Queues the actual WhatsApp send via the existing whatsapp-outbound
 * worker/queue. Call this AFTER the triggering transaction has committed
 * (same pattern webhookController.js already uses for the buyer path) —
 * enqueuing a job whose handler reads DB state before the transaction that
 * state depends on has committed is a real race, not a style preference.
 *
 * threadId/leadId are intentionally omitted (undefined) — this is what
 * whatsappOutboundWorker.js's threadId-guard (see that file) relies on to
 * skip the buyer-shaped whatsapp_messages logging for agent-targeted sends.
 */
async function enqueueAgentWhatsappSend({ tenantId, phone, messageBody }) {
  await whatsappOutboundQueue.add('send-agent-message', {
    tenantId,
    phone,
    messageBody,
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

/**
 * Detects the language to reply in, for contexts (like an image message,
 * or a debounced background job) where there's no single "current
 * message" in scope to detect from directly — uses the most recent
 * inbound TEXT message logged for this draft as the best available proxy
 * for "what language is this person using right now." A pure image
 * message has no text of its own to detect from, so a bare photo with no
 * prior text at all correctly falls through to detectReplyLanguage's own
 * default (English).
 */
async function detectDraftLanguage(knex, draftId) {
  if (!draftId) return detectReplyLanguage(null);
  const lastInbound = await knex('agent_draft_messages')
    .where({ draft_id: draftId, direction: 'inbound' })
    .orderBy('created_at', 'desc')
    .first();
  return detectReplyLanguage(lastInbound?.body);
}

module.exports = { logAgentOutboundMessage, enqueueAgentWhatsappSend, detectDraftLanguage };
