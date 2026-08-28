// src/workers/agentIntakeWorker.js
//
// Consumes queue 'agent-listing-intake' (two job names: 'extract' and
// 'send-preview'). Mirrors vocallmWorker.js's grounding discipline,
// inverted: extracting structured fields FROM an agent's freeform WhatsApp
// text instead of generating a reply FROM database facts. Same "never
// invent, only use what's actually there" constraint either way.
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { createListingRecord, enqueueGeoEnrichment, ListingLimitError } = require('../services/listingService');
const { logAgentOutboundMessage, enqueueAgentWhatsappSend, detectDraftLanguage } = require('../services/agentMessagingService');
const { extractListingFields, REQUIRED_FIELDS, FIELD_QUESTIONS: FIELD_QUESTIONS_HI } = require('../services/listingExtractionService');
const { FIELD_QUESTIONS_EN } = require('../utils/replyLanguage');
const {
  linkOrCreateBuilderProfileCore,
  buildBuilderAutoLinkNote,
  BuilderProfileLinkError,
  BUILDER_ELIGIBLE_TYPES,
} = require('../controllers/builderProfileController');

// WhatsApp counterpart to webChatController.js's autoLinkBuilderProfile —
// same trigger ("flat available in DLF Chandigarh One" naming a specific
// building/mall), same underlying linkOrCreateBuilderProfileCore, just
// sent as a separate outbound WhatsApp message here instead of appended
// inline to a synchronous HTTP reply, since this worker's own replies are
// already fire-and-forget messages rather than one HTTP response body.
async function sendBuilderAutoLinkNote({ tenantId, phone, draftId, listingId, propertyType, buildingName, lang }) {
  if (!buildingName || !BUILDER_ELIGIBLE_TYPES.includes(propertyType)) return;
  try {
    const { profile, isNew } = await linkOrCreateBuilderProfileCore(knex, { tenantId, listingId, companyName: buildingName });
    const body = buildBuilderAutoLinkNote({ isNew, companyName: profile.company_name, lang }).trim();
    await knex.transaction(async (trx) => { await logAgentOutboundMessage(trx, { draftId, body }); });
    await enqueueAgentWhatsappSend({ tenantId, phone, messageBody: body });
  } catch (err) {
    if (!(err instanceof BuilderProfileLinkError)) {
      console.error('Agent intake: builder auto-link failed:', err.message);
    }
  }
}

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

console.log(`[Worker Engine] Initializing Agent WhatsApp Listing Intake Processor...`);

function buildPreviewLink(publicSlug) {
  return `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/p/${publicSlug}`;
}

function fieldQuestionsFor(lang) {
  return lang === 'en' ? FIELD_QUESTIONS_EN : FIELD_QUESTIONS_HI;
}

/**
 * Sends the "here's your listing, reply to approve" message and flips the
 * draft to awaiting_approval. Shared between the 'send-preview' job
 * (triggered by geoEnrichmentWorker.js after a fresh geocode) and the
 * no-address-change correction path below (which can skip straight back
 * to preview without waiting on a re-geocode).
 */
async function sendPreviewAndAwaitApproval({ draftId, listingId }) {
  const lang = await detectDraftLanguage(knex, draftId);

  const result = await knex.transaction(async (trx) => {
    const listing = await trx('listings').where({ id: listingId }).first();
    const draft = await trx('agent_listing_drafts').where({ id: draftId }).first();
    if (!listing || !draft) return null;

    const previewBody = lang === 'en'
      ? `Here's your listing preview:\n${buildPreviewLink(listing.public_slug)}\n\nReply "yes" or "approve" if it looks right — it'll go live. Send a new detail if anything needs changing.`
      : `Yeh raha aapki listing ka preview:\n${buildPreviewLink(listing.public_slug)}\n\nSahi hai to reply karo "haan" ya "approve" — publish ho jayegi. Kuch badalna hai to naya detail bhej dijiye.`;

    await logAgentOutboundMessage(trx, { draftId, body: previewBody });
    await trx('agent_listing_drafts')
      .where({ id: draftId })
      .update({ status: 'awaiting_approval', last_preview_sent_at: trx.fn.now(), updated_at: trx.fn.now() });

    return { tenantId: draft.tenant_id, phone: (await trx('users').where({ id: draft.user_id }).first()).phone, messageBody: previewBody };
  });

  if (result) {
    await enqueueAgentWhatsappSend(result);
  }
}

const agentIntakeWorker = new Worker('agent-listing-intake', async (job) => {
  if (job.name === 'send-preview') {
    const { draftId, listingId } = job.data;
    console.log(`[Job ${job.id}] Sending agent-intake preview for listing ${listingId}`);
    await sendPreviewAndAwaitApproval({ draftId, listingId });
    return { success: true };
  }

  if (job.name !== 'extract') {
    console.warn(`[Job ${job.id}] Unknown job name '${job.name}' on agent-listing-intake, skipping.`);
    return { success: false, skipped: true };
  }

  const { draftId } = job.data;
  console.log(`[Job ${job.id}] Extracting listing fields for draft ${draftId}`);

  const draft = await knex('agent_listing_drafts').where({ id: draftId }).first();
  if (!draft || draft.status === 'approved') {
    return { success: true, skipped: true }; // stale job — draft already finished
  }

  await knex('agent_listing_drafts').where({ id: draftId }).update({ status: 'extracting', updated_at: knex.fn.now() });

  const agentUser = await knex('users').where({ id: draft.user_id }).first();
  const extracted = await extractListingFields(draft.accumulated_text);

  if (!draft.listing_id) {
    // First-time creation path.
    const missing = REQUIRED_FIELDS.filter((f) => !extracted[f]);

    if (missing.length > 0) {
      await knex('agent_listing_drafts').where({ id: draftId }).update({
        status: 'collecting',
        extracted_fields: JSON.stringify(extracted),
        missing_fields: JSON.stringify(missing),
        updated_at: knex.fn.now(),
      });

      const lang = await detectDraftLanguage(knex, draftId);
      const questions = fieldQuestionsFor(lang);
      const questionBody = missing.map((f) => questions[f]).join(' ');
      await knex.transaction(async (trx) => {
        await logAgentOutboundMessage(trx, { draftId, body: questionBody });
      });
      await enqueueAgentWhatsappSend({ tenantId: draft.tenant_id, phone: agentUser.phone, messageBody: questionBody });
      return { success: true, missing };
    }

    await knex('agent_listing_drafts').where({ id: draftId }).update({ status: 'creating', updated_at: knex.fn.now() });

    try {
      const newListing = await createListingRecord(knex, {
        tenantId: draft.tenant_id,
        createdBy: draft.user_id,
        source: 'whatsapp',
        draftId,
        title: extracted.title,
        rawAddress: extracted.raw_address,
        price: extracted.price,
        pincode: extracted.pincode,
        plotArea: extracted.plot_area,
        propertyType: extracted.property_type,
        description: extracted.description,
      });

      await knex('agent_listing_drafts').where({ id: draftId }).update({
        listing_id: newListing.id,
        status: 'enriching', // geo-enrichment is now running in the background (geoEnrichmentWorker.js)
        extracted_fields: JSON.stringify(extracted),
        missing_fields: null,
        updated_at: knex.fn.now(),
      });

      // "flat available in DLF Chandigarh One" / "retail space in Elante
      // Mall" — a named building/mall auto-links a builder profile right
      // at creation, same as the manual dashboard button, just inline.
      // Sent as its own WhatsApp message rather than folded into the
      // preview (which only goes out later, once geocoding finishes).
      await sendBuilderAutoLinkNote({
        tenantId: draft.tenant_id, phone: agentUser.phone, draftId, listingId: newListing.id,
        propertyType: extracted.property_type, buildingName: extracted.building_name,
        lang: await detectDraftLanguage(knex, draftId),
      });
    } catch (err) {
      if (err instanceof ListingLimitError) {
        await knex('agent_listing_drafts').where({ id: draftId }).update({ status: 'collecting', updated_at: knex.fn.now() });
        await knex.transaction(async (trx) => { await logAgentOutboundMessage(trx, { draftId, body: err.message }); });
        await enqueueAgentWhatsappSend({ tenantId: draft.tenant_id, phone: agentUser.phone, messageBody: err.message });
        return { success: true, blocked: 'listing_limit' };
      }
      throw err;
    }

    return { success: true, created: true };
  }

  // Correction path — draft.listing_id already exists (post-preview edit).
  // COALESCE: only overwrite a field when GPT actually returned a new
  // value for it — never let a corrected re-extraction silently blank out
  // a previously-confirmed fact just because this particular message
  // didn't repeat it.
  const existingListing = await knex('listings').where({ id: draft.listing_id }).first();

  // Defensive validation here too, same as listingService.js's
  // createListingRecord — this correction path writes directly via
  // knex('listings').update(), bypassing that function's own regex check,
  // so a malformed value from GPT (violating the "only extract a literal
  // 6-digit PIN" instruction) doesn't end up polluting the strict
  // geocoding filter downstream.
  const rawPincode = extracted.pincode ?? existingListing.pincode;
  const validPincode = (typeof rawPincode === 'string' && /^\d{6}$/.test(rawPincode.trim())) ? rawPincode.trim() : null;

  const merged = {
    title: extracted.title ?? existingListing.title,
    raw_address: extracted.raw_address ?? existingListing.raw_address,
    price: extracted.price ?? existingListing.price,
    pincode: validPincode,
    plot_area: extracted.plot_area ?? existingListing.plot_area,
    property_type: extracted.property_type ?? existingListing.property_type,
    description: extracted.description ?? existingListing.description,
  };

  await knex('agent_listing_drafts').where({ id: draftId }).update({ status: 'creating', updated_at: knex.fn.now() });

  const addressChanged = merged.raw_address !== existingListing.raw_address;
  // A pincode-only correction ("pincode 141001" as a follow-up, no new
  // address text) still needs to re-geocode — pincode becomes a much
  // stronger filter in geoEnrichmentWorker.js, same reasoning as the web
  // chat side (webChatController.js's needsReenrichment).
  const pincodeChanged = merged.pincode !== (existingListing.pincode || null);
  const needsReenrichment = addressChanged || pincodeChanged;

  if (!needsReenrichment) {
    // Even when the address text didn't change, re-geocode if the listing
    // never got coordinates (a previous geo attempt failed). Sending a
    // preview for a listing with no lat/lng is worse than re-trying.
    if (!existingListing.lat || !existingListing.lng) {
      await knex('listings').where({ id: draft.listing_id }).update({
        ...merged,
        formatted_address: null,
        lat: null,
        lng: null,
        status: 'pending',
        updated_at: knex.fn.now(),
      });
      await knex('agent_listing_drafts').where({ id: draftId }).update({
        status: 'enriching',
        extracted_fields: JSON.stringify(merged),
        updated_at: knex.fn.now(),
      });
      await enqueueGeoEnrichment({ listingId: draft.listing_id, rawAddress: merged.raw_address, draftId });
      return { success: true, corrected: true, reGeocoded: true };
    }

    await knex('listings').where({ id: draft.listing_id }).update({
      title: merged.title,
      price: merged.price,
      pincode: merged.pincode,
      plot_area: merged.plot_area,
      property_type: merged.property_type,
      description: merged.description,
      updated_at: knex.fn.now(),
    });
    await knex('agent_listing_drafts').where({ id: draftId }).update({
      status: 'enriching',
      extracted_fields: JSON.stringify(merged),
      updated_at: knex.fn.now(),
    });

    // A building/mall name can arrive on a correction message too ("it's
    // actually in DLF Chandigarh One") rather than at first creation.
    await sendBuilderAutoLinkNote({
      tenantId: draft.tenant_id, phone: agentUser.phone, draftId, listingId: draft.listing_id,
      propertyType: merged.property_type, buildingName: extracted.building_name,
      lang: await detectDraftLanguage(knex, draftId),
    });

    // Same slug/link, no re-geocode needed — go straight back to preview.
    await sendPreviewAndAwaitApproval({ draftId, listingId: draft.listing_id });
    return { success: true, corrected: true, reGeocoded: false };
  }

  // Address or pincode changed — hide the stale card and re-run enrichment.
  await knex('listings').where({ id: draft.listing_id }).update({
    ...merged,
    formatted_address: null,
    lat: null,
    lng: null,
    status: 'pending',
    updated_at: knex.fn.now(),
  });
  await knex('agent_listing_drafts').where({ id: draftId }).update({
    status: 'enriching',
    extracted_fields: JSON.stringify(merged),
    updated_at: knex.fn.now(),
  });
  await enqueueGeoEnrichment({ listingId: draft.listing_id, rawAddress: merged.raw_address, draftId });

  await sendBuilderAutoLinkNote({
    tenantId: draft.tenant_id, phone: agentUser.phone, draftId, listingId: draft.listing_id,
    propertyType: merged.property_type, buildingName: extracted.building_name,
    lang: await detectDraftLanguage(knex, draftId),
  });

  return { success: true, corrected: true, reGeocoded: true };
}, { connection: redisConnection });

agentIntakeWorker.on('failed', async (job, err) => {
  console.error(`❌ [Job ${job?.id}] Agent intake task failed permanently:`, err.message);

  if (job?.name === 'extract' && job.attemptsMade >= job.opts.attempts) {
    const { draftId } = job.data;
    try {
      const draft = await knex('agent_listing_drafts').where({ id: draftId }).first();
      if (!draft) return;
      const agentUser = await knex('users').where({ id: draft.user_id }).first();

      await knex('agent_listing_drafts').where({ id: draftId }).update({ status: 'collecting', updated_at: knex.fn.now() });

      const lang = await detectDraftLanguage(knex, draftId);
      const body = lang === 'en'
        ? "Sorry, I couldn't understand that — please try again with the property type, location, and a title."
        : "Samajh nahi paya, please dobara try karein — property type, location, aur title zaroor batayein.";
      await knex.transaction(async (trx) => { await logAgentOutboundMessage(trx, { draftId, body }); });
      await enqueueAgentWhatsappSend({ tenantId: draft.tenant_id, phone: agentUser.phone, messageBody: body });
    } catch (notifyErr) {
      console.error(`[Job ${job?.id}] Failed to notify agent of extraction failure:`, notifyErr.message);
    }
  }
});

module.exports = agentIntakeWorker;
