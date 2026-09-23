const crypto = require('crypto');
const { Queue } = require('bullmq');
const { normalizePhone } = require('../utils/phone');
const { handleAgentIntakeMessage, handleAgentIntakePhoto, uploadAgentPhoto, handleAgentLocationPin } = require('./agentIntakeController');
const { handleAgentSignupMessage } = require('./agentSignupController');
const { handleAgentReceiptIntent, handleAgentReceiptPhoto } = require('./agentPaymentController');
const { isReceiptSubmissionIntent, tryHandlePackageSelectionReply } = require('../services/agentPaymentService');
const { resolveTenantByReceivingNumber } = require('../services/tenantWhatsappNumberService');
const { enqueueAgentWhatsappSend } = require('../services/agentMessagingService');
const { handleBuyerSearch } = require('../services/buyerSearchService');
const { detectReplyLanguage } = require('../utils/replyLanguage');
const { handleStillAvailableConfirmation, handleSoldConfirmation } = require('../services/listingStatusCheckService');
const { hasActiveSignupSession, getOrCreateSession, advanceSession } = require('../services/whatsappSignupService');

const MAX_PHOTOS_WHATSAPP = 10; // matches agentIntakeController.js's own constant

// Same fail-fast rationale as listingService.js's geoEnrichmentQueue —
// this is a producer (called from an inbound webhook request), not the
// worker, so it shouldn't hang indefinitely on a Redis blip.
const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 5000),
  connectTimeout: 3000,
};
const vocallmChatQueue = new Queue('vocallm-chat-processor', { connection: redisConnection });

/**
 * Normalizes incoming BSP payloads into a single shape. Edit this isolated
 * helper when swapping between Chat Mitra, Getgabs, or Meta Cloud API —
 * nothing else in this file should need to change.
 */
/**
 * Searches a dealer's active listings for keywords extracted from a buyer's
 * message. Returns a formatted WhatsApp reply with listing links, or null if
 * no relevant listings found or the message isn't a property search.
 */
async function searchDealerListings(knex, tenantId, incomingText) {
  const text = incomingText.toLowerCase();

  // Quick intent check — must look like a property query, not a greeting.
  const propertyKeywords = [
    'plot', 'plots', 'property', 'properties', 'house', 'flat', 'kothi',
    'villa', 'commercial', 'shop', 'land', 'zameen', 'makaan', 'ghar',
    'show', 'list', 'available', 'hai kya', 'milega', 'chahiye', 'want',
    'buy', 'rent', 'sale', 'sell', 'looking', 'search', 'find',
  ];
  const isPropertyQuery = propertyKeywords.some((kw) => text.includes(kw));
  if (!isPropertyQuery) return null;

  const listings = await knex('listings')
    .where({ tenant_id: tenantId, status: 'active' })
    .orderBy('created_at', 'desc')
    .limit(5)
    .select('id', 'title', 'property_type', 'plot_area', 'price', 'public_slug', 'raw_address');

  if (!listings.length) return null;

  const appUrl = process.env.PUBLIC_APP_URL || 'https://plotraa.com';
  const lines = listings.map((l) => {
    const price = l.price != null ? `₹${Number(l.price).toLocaleString('en-IN')}` : 'Price on request';
    return `🏷 *${l.title}*\n   ${l.property_type} | ${l.plot_area || '-'} | ${price}\n   ${appUrl}/p/${l.public_slug}`;
  });

  return `Here are the available properties:\n\n${lines.join('\n\n')}\n\nTap any link to view full details, satellite view, and nearby landmarks. 📍`;
}

function parseInboundPayload(body) {
  // Meta Cloud API wraps the actual message data inside entry[0].changes[0].value.
  // Other BSPs (Gupshup, Interakt, Chat Mitra) send a flat top-level body.
  // Unwrap if the envelope is present; fall back to the raw body otherwise so
  // non-Meta BSPs continue to work unchanged.
  const value = body.entry?.[0]?.changes?.[0]?.value ?? body;

  return {
    phone: value.contacts?.[0]?.wa_id || body.from_phone || body.sender?.phone,
    leadName: value.contacts?.[0]?.profile?.name || body.from_name || body.sender?.name || 'Visitor',
    // An image message's caption (Meta Cloud API) lives at
    // messages[0].image.caption, NOT .text.body — this used to only check
    // .text.body, so a photo sent WITH a caption (e.g. answering "what
    // type of property?" with a photo captioned "commercial property")
    // had that caption silently discarded. See handleInboundWhatsApp's
    // agent-intake routing below for how a caption is now used.
    incomingText: value.messages?.[0]?.text?.body || value.messages?.[0]?.image?.caption || body.message_text || body.text,
    // Image message (Meta Cloud API shape) — messages[0].type === 'image'
    // when present, with the actual bytes retrievable via a separate
    // media-id lookup (see agentIntakeController.js's downloadWhatsAppMedia).
    // Only images are handled — a dealer sending a PDF/document isn't a
    // property photo, out of scope for now.
    mediaId: value.messages?.[0]?.image?.id || null,
    mediaMimeType: value.messages?.[0]?.image?.mime_type || null,
    // Meta Cloud API quick-reply button tap: messages[0].type === 'interactive',
    // messages[0].interactive.button_reply.id — ids shaped `available:<listingId>`
    // / `sold:<listingId>` (PR #33 listing status check).
    buttonReplyId: value.messages?.[0]?.interactive?.button_reply?.id || null,
    // Meta Cloud API location-message shape: messages[0].type === 'location',
    // coordinates directly on messages[0].location — no media-id lookup
    // needed. A one-time dropped pin and a "Share Live Location" both reach
    // this webhook this way; `live_location` is checked as a fallback in
    // case a BSP (or a future Cloud API version) ever surfaces a real-time
    // share under its own distinct key instead — cheap to support, and
    // otherwise a live share would silently fail to parse at all.
    locationLat: value.messages?.[0]?.location?.latitude ?? value.messages?.[0]?.live_location?.latitude ?? null,
    locationLng: value.messages?.[0]?.location?.longitude ?? value.messages?.[0]?.live_location?.longitude ?? null,
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

  const { phone, leadName, incomingText, bspThreadRef, inferredSlug, receivingNumber, receivingPhoneNumberId, mediaId, mediaMimeType, buttonReplyId, locationLat, locationLng } = parseInboundPayload(req.body);

  const hasLocation = locationLat != null && locationLng != null;

  console.log('[Webhook] parsed phone=%s text=%s media=%s location=%s button=%s', phone || 'null', incomingText || 'null', mediaId || 'null', hasLocation ? `${locationLat},${locationLng}` : 'null', buttonReplyId || 'null');

  if (!phone || (!incomingText && !mediaId && !hasLocation && !buttonReplyId)) {
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
    // "Still Available" / "Sold" quick-reply button tap from the monthly
    // listing status check — checked first since a button tap carries
    // neither mediaId nor incomingText. Verifies the listing belongs to
    // this agent's tenant before acting.
    if (buttonReplyId) {
      const [action, listingId] = buttonReplyId.split(':');
      if ((action === 'available' || action === 'sold') && listingId) {
        const listing = await knex('listings').where({ id: listingId, tenant_id: agentUser.tenant_id }).first();
        if (listing) {
          if (action === 'available') {
            await handleStillAvailableConfirmation(knex, { listingId, agentUser });
          } else {
            await handleSoldConfirmation(knex, { listingId, agentUser });
          }
          return res.status(200).json({ success: true, statusCheckAction: action });
        }
      }
      return res.status(200).json({ success: true, warning: 'Unrecognized or unauthorized button reply.' });
    }

    // Payment: a photo while awaiting_receipt_submission is armed is a
    // receipt, not a property photo — checked first among the media
    // branches so it's never mistaken for a listing photo.
    if (agentUser.awaiting_receipt_submission && mediaId) {
      return handleAgentReceiptPhoto({ knex, agentUser, mediaId, mediaMimeType, res });
    }

    // Payment: a bare numeric reply while no package is chosen yet is a
    // package-menu selection, not listing text.
    if (!mediaId && incomingText && !agentUser.package_id) {
      const claimed = await tryHandlePackageSelectionReply(knex, { agentUser, incomingText: incomingText.trim() });
      if (claimed) return res.status(200).json({ success: true, packageSelected: true });
    }

    // Payment: "payment"/"receipt"/"bhugtan" etc. arms the receipt-photo flag.
    if (!mediaId && incomingText && isReceiptSubmissionIntent(incomingText)) {
      return handleAgentReceiptIntent({ knex, agentUser, res });
    }

    // WhatsApp "share location" — agent's GPS pin for the property.
    if (hasLocation) {
      return handleAgentLocationPin({
        knex,
        agentUser,
        lat: locationLat,
        lng: locationLng,
        bspMessageId: bspThreadRef,
        res,
      });
    }

    if (mediaId && incomingText && incomingText.trim()) {
      // Photo WITH caption text (e.g. answering "what type of property?"
      // with a photo captioned "commercial property") — upload/stash the
      // photo first (best-effort: a failure here shouldn't block progress
      // on the caption's info, which is the more valuable half), then run
      // the caption through the exact same text path a plain message
      // would take. That text path owns the actual reply (missing-fields
      // question, preview link, etc.); the dealer gets a separate short
      // photo-saved confirmation alongside it.
      try {
        const photoResult = await uploadAgentPhoto({ knex, agentUser, mediaId, mediaMimeType });
        if (photoResult.status !== 'limit_reached') {
          const confirmBody = photoResult.status === 'attached'
            ? `📷 Photo added (${photoResult.count}/${MAX_PHOTOS_WHATSAPP}).`
            : `📷 Photo saved (${photoResult.count}/${MAX_PHOTOS_WHATSAPP}) — will attach it once your listing is created.`;
          await enqueueAgentWhatsappSend({ tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: confirmBody });
        }
      } catch (photoErr) {
        console.error('Agent intake: photo+caption upload failed (continuing with caption text):', photoErr.message);
      }

      return handleAgentIntakeMessage({
        knex,
        agentUser,
        incomingText: incomingText.trim(),
        bspMessageId: bspThreadRef,
        res,
      });
    }

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

  // Agent self-registration: a "join as agent" message (or a follow-up in
  // an already-started signup conversation) from a phone that ISN'T a
  // known agent yet. Checked before the buyer/lead path so it isn't
  // mistaken for a buyer inquiry. Claims the message (and responds) only
  // when it's actually signup-related — otherwise the buyer path below
  // runs completely unchanged, exactly as before this flow existed.
  const signupHandled = await handleAgentSignupMessage({
    knex,
    phone,
    leadName,
    incomingText: incomingText.trim(),
    receivingPhoneNumberId,
    receivingNumber,
    res,
  });
  if (signupHandled) return;

  // Marketplace search (shared platform number ONLY): a brand-new
  // conversation — no existing thread for this bsp_thread_ref, no existing
  // lead for this phone, and no inferredSlug (i.e. the buyer didn't arrive
  // via a specific listing's own link) — that lands on a receiving
  // number NO dealer has registered (resolveTenantByReceivingNumber
  // returns null) is treated as an open-ended cross-tenant property
  // search instead of being silently attributed to "the oldest active
  // tenant's newest listing" (the old, unrelated-to-what-was-typed
  // fallback below).
  //
  // Deliberately checked with plain `knex`, before the transaction below
  // even opens — this path never creates a lead/thread/listing
  // association (see buyerSearchService.js: it's a stateless search+
  // reply), so it doesn't need transactional isolation, and checking here
  // means the entire transaction below — the existing dealer-number /
  // specific-listing flow — is completely untouched by this feature: if
  // handleBuyerSearch returns null (not a confident search, or this
  // wasn't even eligible), execution falls straight through to the
  // existing code exactly as it ran before this feature existed.
  const existingThreadForSearch = bspThreadRef
    ? await knex('whatsapp_threads').where({ bsp_thread_ref: bspThreadRef }).first()
    : null;
  const existingLeadForSearch = !existingThreadForSearch
    ? await knex('leads').where({ phone }).first()
    : null;

  if (!existingThreadForSearch && !existingLeadForSearch && !inferredSlug) {
    const receivingDealer = await resolveTenantByReceivingNumber(knex, {
      phoneNumberId: receivingPhoneNumberId,
      whatsappNumber: receivingNumber,
    });

    if (!receivingDealer) {
      // Shared platform number: try marketplace search first.
      const searchResult = await handleBuyerSearch(knex, { incomingText: incomingText.trim(), buyerPhone: phone });
      if (searchResult) {
        await enqueueAgentWhatsappSend({ tenantId: null, phone, messageBody: searchResult.replyText });
        return res.status(200).json({ success: true, marketplaceSearch: true, matchCount: searchResult.matchCount });
      }
    }

    // Cold contact on a dealer's number: try to answer as a listing search
    // before falling back to the generic greeting.
    if (receivingDealer) {
      const searchReply = await searchDealerListings(knex, receivingDealer.id, incomingText);
      if (searchReply) {
        await enqueueAgentWhatsappSend({ tenantId: receivingDealer.id, phone, messageBody: searchReply });
        return res.status(200).json({ success: true, dealerListingSearch: true });
      }
    }

    // Not a recognisable property query — send friendly intro.
    const lang = detectReplyLanguage(incomingText);
    const coldGreeting = lang === 'en'
      ? `Hi there! 👋 This number is for Plotraa property agents.\n\n• *Looking for a property?* Tell me the area and type (e.g. "plots in Ludhiana") and I'll show you available listings.\n• *Want to list properties as an agent?* Reply: *join as agent*`
      : `Namaste! 👋 Yeh number Plotraa ke property agents ke liye hai.\n\n• *Property dhundh rahe hain?* Area aur type batayein (jaise "Ludhiana mein plot") aur main available listings dikha dunga.\n• *Agent ke roop mein property list karna chahte hain?* Reply karein: *join as agent*`;

    await enqueueAgentWhatsappSend({ tenantId: receivingDealer?.id || null, phone, messageBody: coldGreeting });
    return res.status(200).json({ success: true, coldContact: true });
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
          // number. Checks every number a tenant has registered (see
          // tenantWhatsappNumberService.js — a Tier 2/3 tenant can have up
          // to 3/5), not just one. Falls back to the shared-number path
          // (oldest active tenant) only when NEITHER identifier resolves
          // to any tenant's number, which means it arrived on the
          // platform's shared number where the inferredSlug-based lookup
          // below further narrows it down.
          let defaultTenant = await resolveTenantByReceivingNumber(trx, {
            phoneNumberId: receivingPhoneNumberId,
            whatsappNumber: receivingNumber,
          });

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
