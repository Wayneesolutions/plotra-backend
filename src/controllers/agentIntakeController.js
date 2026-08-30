const { Queue } = require('bullmq');
const axios = require('axios');
const { isApprovalReply } = require('../utils/agentReplyIntent');
const { logAgentOutboundMessage, enqueueAgentWhatsappSend, detectDraftLanguage } = require('../services/agentMessagingService');
const { detectReplyLanguage } = require('../utils/replyLanguage');
const { uploadToS3 } = require('../services/s3Service');
const { extractListingFields } = require('../services/listingExtractionService');
const { recordImplicitApprovalIfUncorrected } = require('../services/resolvedLocalityService');

const MAX_PHOTOS_WHATSAPP = 10;

/**
 * Derives the Meta Graph API base (origin + version) from BSP_GATEWAY_URL,
 * which is already configured for outbound sends
 * (whatsappOutboundWorker.js), shaped like
 * https://graph.facebook.com/v25.0/{phone_number_id}/messages — reuses
 * that same config rather than requiring a separate env var. Meta-
 * specific, matching the existing level of BSP-agnosticism (outbound
 * send is already hardcoded to Meta Cloud API's payload shape too, not
 * abstracted across BSPs).
 */
function graphApiBase() {
  const gatewayUrl = process.env.BSP_GATEWAY_URL;
  if (!gatewayUrl) return null;
  try {
    const url = new URL(gatewayUrl);
    const segments = url.pathname.split('/').filter(Boolean); // ['v25.0', '{phone_number_id}', 'messages']
    const version = segments[0];
    return version ? `${url.origin}/${version}` : null;
  } catch {
    return null;
  }
}

/**
 * Downloads a WhatsApp media attachment. Meta Cloud API is a two-step
 * fetch: the media id first resolves to a short-lived signed URL, which
 * itself STILL requires the same Bearer token to actually download —
 * unlike a typical presigned S3-style URL, Meta's media URLs aren't
 * public on their own.
 */
async function downloadWhatsAppMedia(mediaId) {
  const base = graphApiBase();
  const token = process.env.BSP_API_KEY;
  if (!base || !token) {
    throw new Error('WhatsApp media API not configured (BSP_GATEWAY_URL/BSP_API_KEY).');
  }

  const metaRes = await axios.get(`${base}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });
  const mediaUrl = metaRes.data?.url;
  if (!mediaUrl) throw new Error('WhatsApp media lookup returned no downloadable URL.');

  const fileRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    timeout: 20000,
  });
  return Buffer.from(fileRes.data);
}

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
  const jobId = `extract-${draftId}`;
  try {
    // Remove any stale completed/failed job with this ID before adding —
    // BullMQ blocks duplicate jobIds regardless of state, so a previously
    // failed extraction would permanently block retries for the same draft.
    const existing = await agentIntakeQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') await existing.remove();
    }
    await agentIntakeQueue.add('extract', { draftId }, {
      delay: EXTRACT_DEBOUNCE_MS,
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } catch (err) {
    console.log(`[agentIntake] extract job for draft ${draftId} already scheduled:`, err.message);
  }
}

function buildConfirmationMessage(publicSlug, lang) {
  const link = `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/p/${publicSlug}`;
  return lang === 'en'
    ? `It's live! Here's your link, share it with anyone:\n${link}`
    : `Live ho gaya! Yeh raha aapka link, kisi ko bhi bhej sakte ho:\n${link}`;
}

function buildStillAwaitingApprovalMessage(lang) {
  return lang === 'en'
    ? `Your previous listing is still awaiting approval. Reply "yes" or "approve" to publish it, or send the details you'd like to change.`
    : `Aapki pichli listing abhi approval ka wait kar rahi hai. "haan" ya "approve" reply karke publish karein, ya jo detail badalni hai wo bhejein.`;
}

/**
 * Sent instead of buildStillAwaitingApprovalMessage() when this is the
 * SECOND (or later) consecutive non-informative reply in a row — e.g. the
 * dealer already said "it's wrong" once and is now saying "how do I fix
 * it" without actually giving a corrected value. Repeating the identical
 * generic line a second time reads as the bot being stuck/broken; this
 * version is explicit about what kind of reply actually moves things
 * forward, with a concrete example.
 */
function buildNeedsCorrectionDetailMessage(lang) {
  return lang === 'en'
    ? `I still don't have a corrected value to change — please send the actual detail, e.g. "Ludhiana" or "price 55 lakh". Or reply "yes" to publish it as-is.`
    : `Mujhe abhi tak sahi/corrected value nahi mili — please asli detail bhejein, jaise "Ludhiana" ya "price 55 lakh". Ya "yes" bolke isko jaisa hai waisa publish kar dein.`;
}

/**
 * True if a GPT extraction pass over a single message came back with
 * nothing at all — e.g. "Hello", a thank-you, an emoji. Used to tell a
 * non-informative reply apart from an actual correction while a draft is
 * awaiting_approval, so a stray "Hello" doesn't get silently glued onto
 * accumulated_text and re-trigger extraction.
 */
function hasNoExtractableInfo(fields) {
  return Object.values(fields).every((v) => v === null || v === undefined || String(v).trim() === '');
}

function normalizeAddressText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Heuristic for "this message is about a different property" vs. "this is
 * a correction to the one already awaiting approval." Deliberately loose:
 * treats one address/building name as a match for another if either
 * contains the other once normalized (so "DLF Chandigarh One" still
 * matches "DLF Chandigarh One, Tower 3", and "Sector 45 Mohali" matches
 * "sector-45, Mohali!!"). Only called when the new message actually stated
 * a raw_address/building name — if there's nothing to compare, this
 * assumes it's the same property rather than guessing.
 *
 * Building name is checked first and, when both sides have one, decides
 * the result on its own — two different buildings in the same city
 * ("Agi Flats, Ludhiana" vs. an existing "Hero Homes, Ludhiana" draft)
 * would otherwise both contain the shared "ludhiana" substring and be
 * wrongly read as the same property if only raw_address were compared.
 */
function isDifferentProperty(newFields, existingListing) {
  const newBuilding = normalizeAddressText(newFields.building_name);
  const existingBuilding = normalizeAddressText(existingListing.building_name);
  if (newBuilding && existingBuilding) {
    return !newBuilding.includes(existingBuilding) && !existingBuilding.includes(newBuilding);
  }

  const a = normalizeAddressText(newFields.raw_address);
  const b = normalizeAddressText(existingListing.raw_address);
  if (!a || !b) return false;
  if (a === b) return false;
  return !a.includes(b) && !b.includes(a);
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
    // Peek (no lock) at whether this agent currently has a draft sitting in
    // awaiting_approval. If so, and this isn't a plain "yes", we need to
    // know what — if anything — THIS message alone actually says before we
    // decide whether to remind, correct, or start a fresh draft. That GPT
    // call must happen BEFORE the row-locking transaction below: holding a
    // DB connection + `FOR UPDATE` lock open across an external API
    // round-trip is the anti-pattern the rest of this codebase avoids
    // (BullMQ enqueues are deliberately kept outside the transaction for
    // the same reason). The authoritative status check still happens
    // inside the transaction; this is discarded if the locked read finds
    // the status already moved on.
    let awaitingApprovalContext = null;
    if (!isApprovalReply(incomingText)) {
      const draftPeek = await knex('agent_listing_drafts')
        .where({ user_id: agentUser.id, tenant_id: agentUser.tenant_id, status: 'awaiting_approval' })
        .first();

      if (draftPeek) {
        try {
          // Fetch the listing's current values FIRST and feed them to
          // extraction as correction context — without this, a short reply
          // like "wrong information i typed ludhiana" has no way to be read
          // as "replace raw_address with Ludhiana" (see
          // listingExtractionService.js's correctionContext param), and GPT
          // extracts nothing, which is what caused the identical-reminder
          // loop dealers were hitting on a genuine correction attempt.
          const existingListingForContext = draftPeek.listing_id
            ? await knex('listings').where({ id: draftPeek.listing_id }).first()
            : null;
          const correctionContext = existingListingForContext
            ? {
                raw_address: existingListingForContext.raw_address,
                building_name: existingListingForContext.building_name,
                price: existingListingForContext.price,
                property_type: existingListingForContext.property_type,
              }
            : undefined;

          const messageFields = await extractListingFields(incomingText, correctionContext);
          const hasInfo = !hasNoExtractableInfo(messageFields);

          // A bare correction fragment ("Ludhiana", "60 lakh") only ever
          // populates ONE field and is typically just a locality/city
          // string with no property_type or building_name attached — that's
          // the whole point, it's supplying what was MISSING, not naming a
          // new property. Only run the "is this a different property"
          // check against something that actually names a specific new
          // property: either an explicit property_type, or a building/
          // society name — a message like "agi flats ludhiana" has neither
          // a raw_address+property_type pair nor is a bare fragment, but
          // its building_name ("Agi Flats") is exactly the kind of concrete
          // signal that should trigger the check even without an explicit
          // property type.
          const looksLikeFullNewListing = hasInfo && !!messageFields.raw_address
            && (!!messageFields.property_type || !!messageFields.building_name);
          let differentProperty = false;
          if (looksLikeFullNewListing && existingListingForContext) {
            differentProperty = isDifferentProperty(messageFields, existingListingForContext);
          }
          awaitingApprovalContext = { hasInfo, differentProperty };
        } catch (err) {
          console.error('Agent intake: extraction of awaiting-approval reply failed, falling back to correction:', err.message);
          // GPT unavailable — fall back to the old safe behavior (treat as
          // a same-property correction) rather than silently dropping it.
          awaitingApprovalContext = { hasInfo: true, differentProperty: false };
        }
      }
    }

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

      // Universal approval check: when the agent says "yes" and there's a
      // listing linked to this draft, never treat it as new listing text.
      // Also handles pending (still geocoding) — tell agent to wait rather
      // than appending "yes" to accumulated_text and causing a broken loop.
      if (isApprovalReply(incomingText) && draft.listing_id) {
        const linkedListing = await trx('listings')
          .where({ id: draft.listing_id })
          .whereIn('status', ['awaiting_approval', 'pending'])
          .first();

        await trx('agent_draft_messages').insert({
          draft_id: draft.id,
          direction: 'inbound',
          body: incomingText,
          bsp_message_id: bspMessageId || null,
        });

        if (!linkedListing) return { action: 'noop' };

        if (linkedListing.status === 'pending') {
          const waitBody = detectReplyLanguage(incomingText) === 'en'
            ? 'Your listing is still being processed. Please wait a moment and try again.'
            : 'Aapki listing abhi process ho rahi hai. Thoda wait karein aur dobara try karein.';
          await logAgentOutboundMessage(trx, { draftId: draft.id, body: waitBody });
          return { action: 'send', tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: waitBody };
        }

        const [updatedListing] = await trx('listings')
          .where({ id: draft.listing_id })
          .update({ status: 'active', updated_at: trx.fn.now() })
          .returning(['id', 'public_slug', 'tenant_id', 'building_name', 'raw_address', 'lat', 'lng', 'formatted_address', 'pin_manually_corrected']);

        await recordImplicitApprovalIfUncorrected(trx, updatedListing);

        await trx('agent_listing_drafts')
          .where({ id: draft.id })
          .update({ status: 'approved', updated_at: trx.fn.now() });

        const confirmationBody = buildConfirmationMessage(updatedListing.public_slug, detectReplyLanguage(incomingText));
        await logAgentOutboundMessage(trx, { draftId: draft.id, body: confirmationBody });

        return { action: 'send', tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: confirmationBody };
      }

      if (draft.status === 'awaiting_approval') {
        if (isApprovalReply(incomingText)) {
          await trx('agent_draft_messages').insert({
            draft_id: draft.id,
            direction: 'inbound',
            body: incomingText,
            bsp_message_id: bspMessageId || null,
          });

          const [updatedListing] = await trx('listings')
            .where({ id: draft.listing_id, status: 'awaiting_approval' })
            .update({ status: 'active', updated_at: trx.fn.now() })
            .returning(['id', 'public_slug', 'tenant_id', 'building_name', 'raw_address', 'lat', 'lng', 'formatted_address', 'pin_manually_corrected']);

          if (!updatedListing) {
            // Already approved (or otherwise moved on) by a prior message —
            // treat as a harmless no-op ack, not an error.
            return { action: 'noop' };
          }

          await recordImplicitApprovalIfUncorrected(trx, updatedListing);

          await trx('agent_listing_drafts')
            .where({ id: draft.id })
            .update({ status: 'approved', updated_at: trx.fn.now() });

          const confirmationBody = buildConfirmationMessage(updatedListing.public_slug, detectReplyLanguage(incomingText));
          await logAgentOutboundMessage(trx, { draftId: draft.id, body: confirmationBody });

          return { action: 'send', tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: confirmationBody };
        }

        // Re-check against the fresh, lock-guaranteed status — if the peek
        // above raced with something that moved this draft on (or never
        // saw it as awaiting_approval in the first place), fall through to
        // the generic append-and-extract branch below instead of trusting
        // stale context.
        if (awaitingApprovalContext) {
          if (!awaitingApprovalContext.hasInfo) {
            // Non-informative reply ("Hello", a thank-you, a "this is
            // wrong" with no actual replacement value, etc.) — remind them
            // the previous listing is still pending. Don't touch
            // accumulated_text or re-run extraction. First time, the
            // generic reminder is fine; from the SECOND consecutive one
            // onward, switch to a message that spells out what kind of
            // reply actually moves things forward — repeating the same
            // generic line verbatim reads as the bot being stuck.
            await trx('agent_draft_messages').insert({
              draft_id: draft.id,
              direction: 'inbound',
              body: incomingText,
              bsp_message_id: bspMessageId || null,
            });

            const priorCount = draft.noninformative_reply_count || 0;
            await trx('agent_listing_drafts')
              .where({ id: draft.id })
              .update({ noninformative_reply_count: priorCount + 1, updated_at: trx.fn.now() });

            const lang = detectReplyLanguage(incomingText);
            const reminderBody = priorCount === 0
              ? buildStillAwaitingApprovalMessage(lang)
              : buildNeedsCorrectionDetailMessage(lang);
            await logAgentOutboundMessage(trx, { draftId: draft.id, body: reminderBody });
            return { action: 'send', tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: reminderBody };
          }

          if (awaitingApprovalContext.differentProperty) {
            // A genuinely different property, not a correction to the one
            // awaiting approval — retire the old draft instead of merging
            // this message's text into its accumulated_text, and start a
            // clean one for it.
            await trx('agent_listing_drafts')
              .where({ id: draft.id })
              .update({ status: 'abandoned', updated_at: trx.fn.now() });

            const [newDraft] = await trx('agent_listing_drafts')
              .insert({
                tenant_id: agentUser.tenant_id,
                user_id: agentUser.id,
                status: 'collecting',
                accumulated_text: incomingText,
              })
              .returning(['id']);

            await trx('agent_draft_messages').insert({
              draft_id: newDraft.id,
              direction: 'inbound',
              body: incomingText,
              bsp_message_id: bspMessageId || null,
            });

            return { action: 'extract', draftId: newDraft.id };
          }
        }

        await trx('agent_draft_messages').insert({
          draft_id: draft.id,
          direction: 'inbound',
          body: incomingText,
          bsp_message_id: bspMessageId || null,
        });

        // Same-property correction — fall back to collecting and re-run
        // extraction over the full accumulated history (draft.listing_id
        // stays set, so agentIntakeWorker.js takes the update-existing-
        // listing branch). Reset noninformative_reply_count — this reply
        // DID have real, extractable info, so the streak is over.
        await trx('agent_listing_drafts')
          .where({ id: draft.id })
          .update({
            status: 'collecting',
            accumulated_text: trx.raw(`TRIM(accumulated_text || ' ' || ?)`, [incomingText]),
            noninformative_reply_count: 0,
            updated_at: trx.fn.now(),
          });
        return { action: 'extract', draftId: draft.id };
      }

      await trx('agent_draft_messages').insert({
        draft_id: draft.id,
        direction: 'inbound',
        body: incomingText,
        bsp_message_id: bspMessageId || null,
      });

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

/**
 * shape but for a property photo instead of text. Attaches to whichever
 * listing the agent's current live draft points at; if there's no live
 * draft with a listing yet, asks them to describe the property first
 * (same UX as the web chat's equivalent "describe the property first"
 * case for a photo sent with no listing context).
 *
 * Deliberately skips the bsp_message_id duplicate-delivery check
 * handleAgentIntakeMessage does — a duplicate webhook delivery here in
 * the worst case uploads the same photo twice, capped by MAX_PHOTOS_WHATSAPP
 * either way, not worth the complexity of also logging an inbound row for
 * every photo (which would otherwise pollute detectDraftLanguage's "most
 * recent inbound message" query with a non-text placeholder).
 */
async function handleAgentIntakePhoto({ knex, agentUser, mediaId, mediaMimeType, bspMessageId, res }) {
  try {
    const draft = await knex('agent_listing_drafts')
      .where({ user_id: agentUser.id, tenant_id: agentUser.tenant_id })
      .whereIn('status', LIVE_STATUSES)
      .first();

    const lang = await detectDraftLanguage(knex, draft?.id);

    if (!draft || !draft.listing_id) {
      const body = lang === 'en'
        ? 'Describe the property first (address, price, type) — then you can send photos.'
        : 'Pehle property describe kar dijiye (address, price, type) — phir photo bhej sakte ho.';
      await enqueueAgentWhatsappSend({ tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: body });
      return res.status(200).json({ success: true });
    }

    const mediaRow = await knex('listing_media').where({ listing_id: draft.listing_id }).first();
    const currentPhotos = mediaRow?.photo_urls || [];

    if (currentPhotos.length >= MAX_PHOTOS_WHATSAPP) {
      const body = `Maximum ${MAX_PHOTOS_WHATSAPP} photos allowed per listing.`;
      await enqueueAgentWhatsappSend({ tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: body });
      return res.status(200).json({ success: true });
    }

    const buffer = await downloadWhatsAppMedia(mediaId);
    const extension = mediaMimeType?.includes('png') ? 'png' : mediaMimeType?.includes('webp') ? 'webp' : 'jpg';
    const url = await uploadToS3(buffer, `whatsapp-${mediaId}.${extension}`, mediaMimeType || 'image/jpeg');

    const updatedPhotos = [...currentPhotos, url];
    if (mediaRow) {
      await knex('listing_media').where({ listing_id: draft.listing_id }).update({ photo_urls: JSON.stringify(updatedPhotos) });
    } else {
      await knex('listing_media').insert({ listing_id: draft.listing_id, photo_urls: JSON.stringify(updatedPhotos) });
    }

    const confirmBody = `📷 ${lang === 'en' ? 'Photo added' : 'Photo add ho gayi'} (${updatedPhotos.length}/${MAX_PHOTOS_WHATSAPP}).`;
    await knex.transaction(async (trx) => {
      await logAgentOutboundMessage(trx, { draftId: draft.id, body: confirmBody });
    });
    await enqueueAgentWhatsappSend({ tenantId: agentUser.tenant_id, phone: agentUser.phone, messageBody: confirmBody });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to process agent WhatsApp photo:', error.message);
    // Still ack 200 so the BSP doesn't retry-storm us — same rationale as
    // handleAgentIntakeMessage and the buyer path in webhookController.js.
    return res.status(200).json({ success: true, trackingError: error.message });
  }
}

module.exports = { handleAgentIntakeMessage, handleAgentIntakePhoto };
