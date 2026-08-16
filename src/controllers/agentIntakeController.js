const { Queue } = require('bullmq');
const { isApprovalReply } = require('../utils/agentReplyIntent');
const { logAgentOutboundMessage, enqueueAgentWhatsappSend } = require('../services/agentMessagingService');

const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  connectTimeout: 3000,
};
const agentIntakeQueue = new Queue('agent-listing-intake', { connection: redisConnection });

const LIVE_STATUSES = ['collecting', 'extracting', 'creating', 'enriching', 'awaiting_approval'];

// Short delay so a few rapid-fire agent messages collapse into one GPT
// extraction call — a cost optimization only, NOT a correctness mechanism:
// agentIntakeWorker.js always re-reads the draft's current accumulated_text
// at execution time, so even if this debounce doesn't collapse perfectly
// (BullMQ's exact duplicate-jobId behavior varies by version — an add()
// failure here is treated as "already scheduled, fine"), nothing breaks.
const EXTRACT_DEBOUNCE_MS = 7000;

async function enqueueExtractJob(draftId) {
  try {
    await agentIntakeQueue.add('extract', { draftId }, {
      delay: EXTRACT_DEBOUNCE_MS,
      jobId: `extract-${draftId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } catch (err) {
    // A duplicate jobId add() failing is expected/harmless — an extraction
    // for this draft is already scheduled.
    console.log(`[agentIntake] extract job for draft ${draftId} already scheduled:`, err.message);
  }
}

function buildConfirmationMessage(publicSlug) {
  const link = `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/p/${publicSlug}`;
  return `Live ho gaya! Yeh raha aapka link, kisi ko bhi bhej sakte ho:\n${link}`;
}

/**
 * Entry point called from webhookController.js when an inbound WhatsApp
 * sender's phone matches a registered agent (users.phone) — the buyer/lead
 * path in that file is completely untouched, this is a fully separate flow.
 *
 * All DB state changes happen inside one transaction with the agent's
 * draft row locked (`FOR UPDATE`) for the duration — combined with the
 * partial unique index from the migration (one live draft per agent), this
 * is what actually prevents two near-simultaneous inbound messages from
 * creating duplicate drafts/listings. BullMQ job enqueues happen AFTER the
 * transaction commits (same pattern webhookController.js's buyer path
 * already uses) — never inside it, since a worker could pick up the job
 * and read DB state before an uncommitted transaction is visible to it.
 */
async function handleAgentIntakeMessage({ knex, agentUser, incomingText, bspMessageId, res }) {
  try {
    const result = await knex.transaction(async (trx) => {
      if (bspMessageId) {
        const dup = await trx('agent_draft_messages')
          .join('agent_listing_drafts', 'agent_draft_messages.draft_id', 'agent_listing_drafts.id')
          .where('agent_listing_drafts.user_id', agentUser.id)
          .andWhere('agent_draft_messages.bsp_message_id', bspMessageId)
          .first();
        if (dup) return { action: 'noop' }; // duplicate webhook delivery
      }

      let draft = await trx('agent_listing_drafts')
        .where({ user_id: agentUser.id, tenant_id: agentUser.tenant_id })
        .whereIn('status', LIVE_STATUSES)
        .forUpdate()
        .first();

      if (!draft) {
        [draft] = await trx('agent_listing_drafts')
          .insert({ tenant_id: agentUser.tenant_id, user_id: agentUser.id, status: 'collecting' })
          .returning(['id', 'status', 'listing_id']);
      }

      await trx('agent_draft_messages').insert({
        draft_id: draft.id,
        direction: 'inbound',
        body: incomingText,
        bsp_message_id: bspMessageId || null,
      });

      if (draft.status === 'awaiting_approval') {
        if (isApprovalReply(incomingText)) {
          const [updatedListing] = await trx('listings')
            .where({ id: draft.listing_id, status: 'awaiting_approval' })
            .update({ status: 'active', updated_at: trx.fn.now() })
            .returning(['id', 'public_slug']);

          if (!updatedListing) {
            // Already approved (or otherwise moved on) by a prior message —
            // treat as a harmless no-op ack, not an error.
            return { action: 'noop' };
          }

          await trx('agent_listing_drafts')
            .where({ id: draft.id })
            .update({ status: 'approved', updated_at: trx.fn.now() });

          const confirmationBody = buildConfirmationMessage(updatedListing.public_slug);
          await logAgentOutboundMessage(trx, { draftId: draft.id, body: confirmationBody });

          return { action: 'send', tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: confirmationBody };
        }

        // Non-approval reply while awaiting approval — treat as a
        // correction: fall back to collecting and re-run extraction over
        // the full accumulated history (draft.listing_id stays set, so
        // agentIntakeWorker.js takes the update-existing-listing branch).
        await trx('agent_listing_drafts')
          .where({ id: draft.id })
          .update({
            status: 'collecting',
            accumulated_text: trx.raw(`TRIM(accumulated_text || ' ' || ?)`, [incomingText]),
            updated_at: trx.fn.now(),
          });
        return { action: 'extract', draftId: draft.id };
      }

      // collecting / extracting / creating / enriching — append and
      // (re)schedule extraction. A message arriving mid-creation/enrichment
      // is still captured; it'll be picked up by the next extraction pass
      // once the draft returns to a state where one runs.
      await trx('agent_listing_drafts')
        .where({ id: draft.id })
        .update({
          accumulated_text: trx.raw(`TRIM(accumulated_text || ' ' || ?)`, [incomingText]),
          updated_at: trx.fn.now(),
        });
      return { action: 'extract', draftId: draft.id };
    });

    if (result.action === 'send') {
      await enqueueAgentWhatsappSend({ tenantId: result.tenantId, phone: result.phone, messageBody: result.messageBody });
    } else if (result.action === 'extract') {
      await enqueueExtractJob(result.draftId);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to process agent WhatsApp intake message:', error.message);
    // Still ack 200 so the BSP doesn't retry-storm us — same rationale as
    // the buyer path in webhookController.js.
    return res.status(200).json({ success: true, trackingError: error.message });
  }
}

module.exports = { handleAgentIntakeMessage };
