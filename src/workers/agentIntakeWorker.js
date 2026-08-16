// src/workers/agentIntakeWorker.js
//
// Consumes queue 'agent-listing-intake' (two job names: 'extract' and
// 'send-preview'). Mirrors vocallmWorker.js's grounding discipline,
// inverted: extracting structured fields FROM an agent's freeform WhatsApp
// text instead of generating a reply FROM database facts. Same "never
// invent, only use what's actually there" constraint either way.
const { Worker, Queue } = require('bullmq');
const IORedis = require('ioredis');
const axios = require('axios');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { createListingRecord, ListingLimitError } = require('../services/listingService');
const { logAgentOutboundMessage, enqueueAgentWhatsappSend } = require('../services/agentMessagingService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot
const geoEnrichmentQueue = new Queue('geo-enrichment', { connection: redisConnection });

console.log(`[Worker Engine] Initializing Agent WhatsApp Listing Intake Processor...`);

const REQUIRED_FIELDS = ['title', 'raw_address', 'price', 'property_type'];
const FIELD_QUESTIONS = {
  raw_address: "Location/address kya hai? (e.g. 'sector 45 mohali')",
  price: 'Price kitni hai? (e.g. 55 lakh)',
  property_type: 'Property type kya hai — Plot, Villa, ya Commercial?',
  title: 'Ek chhota sa title de dijiye is listing ke liye.',
};

function buildPreviewLink(publicSlug) {
  return `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/p/${publicSlug}`;
}

/**
 * Sends the "here's your listing, reply to approve" message and flips the
 * draft to awaiting_approval. Shared between the 'send-preview' job
 * (triggered by geoEnrichmentWorker.js after a fresh geocode) and the
 * no-address-change correction path below (which can skip straight back
 * to preview without waiting on a re-geocode).
 */
async function sendPreviewAndAwaitApproval({ draftId, listingId }) {
  const result = await knex.transaction(async (trx) => {
    const listing = await trx('listings').where({ id: listingId }).first();
    const draft = await trx('agent_listing_drafts').where({ id: draftId }).first();
    if (!listing || !draft) return null;

    const previewBody = `Yeh raha aapki listing ka preview:\n${buildPreviewLink(listing.public_slug)}\n\nSahi hai to reply karo "haan" ya "approve" — publish ho jayegi. Kuch badalna hai to naya detail bhej dijiye.`;

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

/**
 * GPT-4o-mini extraction. Strict JSON, low temperature (structured
 * extraction, not conversation — vocallmWorker.js uses 0.3 for its
 * conversational replies, this uses 0.15). Instructed to never invent a
 * field the agent didn't actually state — the one exception is `title`,
 * which it may synthesize from property_type + area/address when the
 * agent didn't give one explicitly (real agents don't naturally dictate a
 * separate "title" when texting in details), so a listing isn't blocked
 * on a follow-up question for something GPT can reasonably infer.
 */
async function extractListingFields(accumulatedText) {
  const systemPrompt = `You extract real-estate listing fields from a Punjab/India property agent's freeform WhatsApp messages (often Hinglish/Punjabi-English mixed, using local shorthand).

Return ONLY a JSON object with exactly these keys: title, raw_address, price, plot_area, property_type, description.

Rules:
- Use null for any field not actually stated in the text — never guess or invent a value, EXCEPT title (see below).
- price: convert Indian shorthand to a plain number in rupees. "55 lakh" -> 5500000, "1.2 crore" -> 12000000, "80k" -> 80000.
- plot_area: keep as the agent's own phrasing (e.g. "250 gaj", "5 marla", "1200 sq ft") — don't convert units.
- property_type: normalize to one of "Plot", "Villa", or "Commercial" if the text implies one of those (e.g. "3BHK", "house", "makan" -> Villa; "shop", "dukaan" -> Commercial); otherwise null.
- title: if the agent gave an explicit title, use it verbatim. If not, synthesize a short one from property_type + area/locality (e.g. "Plot in Sector 45 Mohali") — but only if you have enough to make a real one; otherwise null.
- description: any other descriptive detail mentioned (amenities, condition, etc.) — null if nothing beyond the core fields.

Examples:
Input: "3BHK plot 250 gaj sector 45 mohali 55 lakh"
Output: {"title":"3BHK Plot in Sector 45 Mohali","raw_address":"Sector 45, Mohali","price":5500000,"plot_area":"250 gaj","property_type":"Plot","description":"3BHK"}

Input: "shop for sale ludhiana 80 lakh"
Output: {"title":"Shop in Ludhiana","raw_address":"Ludhiana","price":8000000,"plot_area":null,"property_type":"Commercial","description":null}`;

  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: accumulatedText },
    ],
    temperature: 0.15,
  }, {
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  return JSON.parse(response.data.choices[0].message.content);
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

      const questionBody = missing.map((f) => FIELD_QUESTIONS[f]).join(' ');
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
  const merged = {
    title: extracted.title ?? existingListing.title,
    raw_address: extracted.raw_address ?? existingListing.raw_address,
    price: extracted.price ?? existingListing.price,
    plot_area: extracted.plot_area ?? existingListing.plot_area,
    property_type: extracted.property_type ?? existingListing.property_type,
    description: extracted.description ?? existingListing.description,
  };

  await knex('agent_listing_drafts').where({ id: draftId }).update({ status: 'creating', updated_at: knex.fn.now() });

  const addressChanged = merged.raw_address !== existingListing.raw_address;

  if (!addressChanged) {
    await knex('listings').where({ id: draft.listing_id }).update({
      title: merged.title,
      price: merged.price,
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
    // Same slug/link, no re-geocode needed — go straight back to preview.
    await sendPreviewAndAwaitApproval({ draftId, listingId: draft.listing_id });
    return { success: true, corrected: true, reGeocoded: false };
  }

  // Address changed — hide the stale card and re-run enrichment.
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
  await geoEnrichmentQueue.add('enrich-property-coords', {
    listingId: draft.listing_id,
    rawAddress: merged.raw_address,
    draftId,
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
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

      const body = "Samajh nahi paya, please dobara try karein — property type, location, aur price zaroor batayein.";
      await knex.transaction(async (trx) => { await logAgentOutboundMessage(trx, { draftId, body }); });
      await enqueueAgentWhatsappSend({ tenantId: draft.tenant_id, phone: agentUser.phone, messageBody: body });
    } catch (notifyErr) {
      console.error(`[Job ${job?.id}] Failed to notify agent of extraction failure:`, notifyErr.message);
    }
  }
});

module.exports = agentIntakeWorker;
