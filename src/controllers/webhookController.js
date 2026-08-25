const crypto = require('crypto');
const { Queue } = require('bullmq');
const { normalizePhone } = require('../utils/phone');
const { handleAgentIntakeMessage, handleAgentIntakePhoto } = require('./agentIntakeController');
const { hasActiveSignupSession, getOrCreateSession, advanceSession } = require('../services/whatsappSignupService');
const { enqueueAgentWhatsappSend } = require('../services/agentMessagingService');

// Same fail-fast rationale as listingService.js's geoEnrichmentQueue —
// this is a producer (called from an inbound webhook request), not the
// worker, so it shouldn't hang indefinitely on a Redis blip.
const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  connectTimeout: 3000,
};
const vocallmChatQueue = new Queue('vocallm-chat-processor', { connection: redisConnection });

/**
 * Normalizes incoming BSP payloads into a single shape. Edit this isolated
 * helper when swapping between Chat Mitra, Getgabs, or Meta Cloud API —
 * nothing else in this file should need to change.
 */
function parseInboundPayload(body) {
  // Meta Cloud API wraps the actual message data inside entry[0].changes[0].value.
  // Other BSPs (Gupshup, Interakt, Chat Mitra) send a flat top-level body.
  // Unwrap if the envelope is present; fall back to the raw body otherwise so
  // non-Meta BSPs continue to work unchanged.
  const value = body.entry?.[0]?.changes?.[0]?.value ?? body;

  return {
    phone: value.contacts?.[0]?.wa_id || body.from_phone || body.sender?.phone,
    leadName: value.contacts?.[0]?.profile?.name || body.from_name || body.sender?.name || 'Visitor',
    incomingText: value.messages?.[0]?.text?.body || body.message_text || body.text,
    // Image message (Meta Cloud API shape) — messages[0].type === 'image'
    // when present, with the actual bytes retrievable via a separate
    // media-id lookup (see agentIntakeController.js's downloadWhatsAppMedia).
    // Only images are handled — a dealer sending a PDF/document isn't a
    // property photo, out of scope for now.
    mediaId: value.messages?.[0]?.image?.id || null,
    mediaMimeType: value.messages?.[0]?.image?.mime_type || null,
    bspThreadRef: value.messages?.[0]?.id || body.conversation_id || body.msg_id,
    inferredSlug: value.messages?.[0]?.context?.referred_slug || body.metadata?.slug || null,
    receivingNumber: value.metadata?.display_phone_number || body.to || body.to_phone || null,
    receivingPhoneNumberId: value.metadata?.phone_number_id || body.metadata?.phone_number_id || null,
  };
}

/**
 * Verifies the BSP's HMAC signature against the RAW request body bytes —
 * not JSON.stringify(req.body). Re-stringifying an already-parsed object
 * doesn't reliably reproduce the exact bytes the sender signed (key order,
 * whitespace, unicode escaping can all differ), so that comparison would
 * fail even for a legitimate request. This requires `req.rawBody` to be
 * captured by express.json()'s `verify` option — see app.js.
 */
function isValidSignature(req, secret) {
  const signature = req.headers['x-hub-signature-256'] || req.headers['x-bsp-signature'];
  if (!secret || !signature) return true; // no secret configured yet — nothing to check against
  if (!req.rawBody) return false; // can't verify without the raw bytes

  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const provided = signature.startsWith('sha256=') ? signature : `sha256=${signature}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(provided));
  } catch {
    return false; // length mismatch etc. — treat as invalid, not a crash
  }
}

/**
 * Core webhook handler — fast ack, log the inbound message, hand off to
 * BullMQ. Does not wait on the AI reply.
 */
async function handleInboundWhatsApp(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const secret = process.env.WHATSAPP_APP_SECRET || process.env.WHATSAPP_WEBHOOK_SECRET;

  if (!isValidSignature(req, secret)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature.' } });
  }

  const { phone, leadName, incomingText, bspThreadRef, inferredSlug, receivingNumber, receivingPhoneNumberId, mediaId, mediaMimeType } = parseInboundPayload(req.body);

  console.log('[Webhook] parsed phone=%s text=%s media=%s', phone || 'null', incomingText || 'null', mediaId || 'null');

  if (!phone || (!incomingText && !mediaId)) {
    // Non-message events (delivery receipts, status updates) — ack and move on
    return res.status(200).json({ success: true, warning: 'Acknowledged non-message event.' });
  }

  // Agent-intake routing: if this inbound sender's phone matches a
  // registered agent (users.phone), this is a WhatsApp listing-intake
  // conversation, not a buyer/lead one — hand off entirely and skip the
  // lead/thread logic below. users.phone is globally unique, so a match
  // also resolves the tenant directly (agentUser.tenant_id) without the
  // phone_number_id/whatsapp_number fallback dance the buyer path needs.
  // Anything that doesn't match a known agent falls through to that
  // existing buyer path, completely unchanged.
  const agentUser = await knex('users').where({ phone: normalizePhone(phone) }).first();
  if (agentUser) {
    // A bare photo (no caption text) — route to the photo handler instead
    // of the text one. A photo WITH caption text still only triggers the
    // photo path here (the caption itself isn't separately fed into
    // extraction) — a dealer sending a photo+caption together is
    // uncommon enough that requiring the address/price as a separate
    // message is an acceptable tradeoff for now.
    if (mediaId) {
      return handleAgentIntakePhoto({
        knex,
        agentUser,
        mediaId,
        mediaMimeType,
        bspMessageId: bspThreadRef,
        res,
      });
    }

    return handleAgentIntakeMessage({
      knex,
      agentUser,
      incomingText: incomingText.trim(),
      bspMessageId: bspThreadRef, // this field is the individual WhatsApp message id (see parseInboundPayload)
      res,
    });
  }

  // Part 3 — WhatsApp self-serve onboarding (Tier 1). Distinct from the
  // shared-number buyer-routing fallback below: WHATSAPP_ONBOARDING_NUMBER/
  // _PHONE_NUMBER_ID is Plotra's own dedicated "sign up here" number, never
  // a number any tenant actually owns or shares for buyer inquiries — so
  // this can never collide with the existing WHATSAPP_SHARED_NUMBER
  // multi-tenant buyer-routing feature. Also continues an already-started
  // signup conversation regardless of which number a later reply reports,
  // so a signup in progress never gets silently dropped mid-conversation.
  const isOnboardingChannel = Boolean(
    (receivingPhoneNumberId && receivingPhoneNumberId === process.env.WHATSAPP_ONBOARDING_PHONE_NUMBER_ID)
    || (receivingNumber && receivingNumber === process.env.WHATSAPP_ONBOARDING_NUMBER)
  );
  if (!mediaId && (isOnboardingChannel || await hasActiveSignupSession(knex, phone))) {
    const session = await getOrCreateSession(knex, phone);
    const replyText = await advanceSession(knex, session, incomingText ? incomingText.trim() : '');
    await enqueueAgentWhatsappSend({ tenantId: null, phone, messageBody: replyText });
    return res.status(200).json({ success: true });
  }

  // Buyer/lead media messages aren't handled — only agent-intake photos
  // are (property listing photos). A buyer sending an image with no
  // caption text would otherwise fall through into the text-processing
  // logic below with incomingText undefined.
  if (!incomingText) {
    return res.status(200).json({ success: true, warning: 'Acknowledged non-text buyer event.' });
  }

  try {
    const resolvedContext = await knex.transaction(async (trx) => {
      let thread = bspThreadRef
        ? await trx('whatsapp_threads').where({ bsp_thread_ref: bspThreadRef }).first()
        : null;

      let lead;
      let listing;

      if (thread) {
        lead = await trx('leads').where({ id: thread.lead_id }).first();
        listing = thread.listing_id
          ? await trx('listings').where({ id: thread.listing_id }).first()
          : null;
      } else {
        lead = await trx('leads').where({ phone }).first();

        if (!lead) {
          // Resolve tenant by whichever identifier this BSP sent — Meta
          // Cloud API sends phone_number_id (opaque, stable per WhatsApp
          // Business number); other BSPs (Gupshup/Interakt) send a raw "to"
          // number. Falls back to the shared-number path (oldest active
          // tenant) only when NEITHER is present, which means it arrived on
          // the platform's shared number where the inferredSlug-based
          // lookup below further narrows it down.
          let defaultTenant = null;

          if (receivingPhoneNumberId) {
            defaultTenant = await trx('tenants')
              .where({ phone_number_id: receivingPhoneNumberId, status: 'active' })
              .first();
          }

          if (!defaultTenant && receivingNumber) {
            defaultTenant = await trx('tenants')
              .where({ whatsapp_number: receivingNumber, status: 'active' })
              .first();
          }

          if (!defaultTenant) {
            // Shared-number fallback: safe only when one tenant uses the
            // shared number. The inferredSlug path below further narrows it.
            defaultTenant = await trx('tenants')
              .where({ status: 'active' })
              .orderBy('created_at', 'asc')
              .first();
          }

          if (!defaultTenant) throw new Error('No active tenant found to attribute this message to.');

          if (inferredSlug) {
            listing = await trx('listings').where({ public_slug: inferredSlug, status: 'active' }).first();
          }
          if (!listing) {
            listing = await trx('listings')
              .where({ tenant_id: defaultTenant.id, status: 'active' })
              .orderBy('created_at', 'desc')
              .first();
          }

          const [newLead] = await trx('leads').insert({
            tenant_id: defaultTenant.id,
            name: leadName,
            phone,
            source: 'whatsapp_inbound',
            status: 'new'
          }).returning(['id', 'tenant_id']);

          lead = newLead;
        } else if (!listing) {
          listing = await trx('listings')
            .where({ tenant_id: lead.tenant_id, status: 'active' })
            .orderBy('created_at', 'desc')
            .first();
        }

        if (!listing) throw new Error('No listing context available to attribute this conversation to.');

        // Reuse an existing open thread for this lead+listing if one exists —
        // without this check, a lead whose earlier thread has no
        // bsp_thread_ref (e.g. one opened via the public-page phone prompt,
        // not a prior inbound message) gets a duplicate thread every time.
        thread = await trx('whatsapp_threads')
          .where({ tenant_id: lead.tenant_id, lead_id: lead.id, listing_id: listing.id, status: 'open' })
          .first();

        if (!thread) {
          const [newThread] = await trx('whatsapp_threads').insert({
            tenant_id: lead.tenant_id,
            lead_id: lead.id,
            listing_id: listing.id,
            bsp_thread_ref: bspThreadRef || `thread_${Date.now()}`,
            status: 'open',
            service_window_expires_at: knex.raw("NOW() + INTERVAL '24 hours'")
          }).returning(['id']);

          thread = newThread;
        } else if (bspThreadRef && !thread.bsp_thread_ref) {
          // Backfill the BSP ref so future messages in this conversation match directly
          await trx('whatsapp_threads').where({ id: thread.id }).update({ bsp_thread_ref: bspThreadRef });
        }
      }

      await trx('whatsapp_messages').insert({
        thread_id: thread.id,
        direction: 'inbound',
        sender_type: 'visitor',
        message_category: 'utility',
        body: incomingText.trim()
      });

      return {
        tenantId: lead.tenant_id,
        threadId: thread.id,
        leadId: lead.id,
        listingId: listing ? listing.id : thread.listing_id
      };
    });

    await vocallmChatQueue.add('process-chat-reply', {
      tenantId: resolvedContext.tenantId,
      threadId: resolvedContext.threadId,
      leadId: resolvedContext.leadId,
      listingId: resolvedContext.listingId,
      incomingText: incomingText.trim(),
      phone: phone.trim()
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Failed to process inbound WhatsApp webhook:', error.message);
    // Still ack 200 so the BSP doesn't retry-storm us; the error is logged server-side.
    return res.status(200).json({ success: true, trackingError: error.message });
  }
}

module.exports = { handleInboundWhatsApp, parseInboundPayload };
