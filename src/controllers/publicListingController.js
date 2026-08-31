const { Queue } = require('bullmq');
const axios = require('axios');
const { normalizePhone, toWaMeDigits } = require('../utils/phone');
const { applyResolvedLocation } = require('../services/locationResolutionService');
const { recordResolvedLocality } = require('../services/resolvedLocalityService');

const redisConnection = { host: process.env.REDIS_HOST || '127.0.0.1', port: process.env.REDIS_PORT || 6379 };

// Same queue whatsappOutboundWorker.js already consumes (Phase 2). Reusing it
// means the first-touch message triggered here gets delivered by code that's
// already built and tested — no new worker needed for Phase 4.
const whatsappOutboundQueue = new Queue('whatsapp-outbound', { connection: redisConnection });

/**
 * Retrieves full structural information for an active public property listing.
 * Strictly adheres to multi-tenant visibility controls and exact error formatting envelopes.
 */
async function getPublicListing(req, res) {
  const knex = req.app.get('db');
  const { slug } = req.params;

  try {
    // 1. Fetch listing details strictly filtering for active storefront status,
    //    joined with the owning tenant for dealer/WhatsApp display info.
    const listing = await knex('listings')
      .join('tenants', 'listings.tenant_id', 'tenants.id')
      // Per-listing WhatsApp attribution (growth/unlimited plans) — when
      // set, this listing's buyer-facing contact is a specific team
      // member's number instead of the tenant's shared default. See
      // migration 20260821_04 and listingService.js's validateAssignedAgent.
      .leftJoin('users as assigned_agent', 'listings.assigned_agent_id', 'assigned_agent.id')
      // Fallback: for listings created before assigned_agent_id was auto-populated
      // by the intake worker, the creator (listings.created_by) is the agent who
      // texted the listing in — their phone is the correct buyer-facing contact.
      .leftJoin('users as creator', 'listings.created_by', 'creator.id')
      // Bug 5 fix: tenant's dedicated buyer-facing number from whatsapp_numbers
      // table (migration 20260830_01) takes priority over tenants.whatsapp_number
      // (the legacy column that was often NULL because the Settings UI 404'd
      // before this table existed). Falls back to tenants.whatsapp_number for
      // tenants who never used the new Settings UI but had the old column set.
      .leftJoin('whatsapp_numbers as tenant_wa', function () {
        this.on('tenant_wa.tenant_id', '=', 'listings.tenant_id')
            .andOnVal('tenant_wa.is_default', '=', true);
      })
      .select(
        'listings.id',
        'listings.tenant_id',
        'listings.title',
        'listings.raw_address',
        'listings.formatted_address',
        'listings.lat',
        'listings.lng',
        'listings.price',
        'listings.plot_area',
        'listings.property_type',
        'listings.description',
        'listings.status',
        'listings.public_slug',
        'tenants.business_name as dealer_business_name',
        'tenants.whatsapp_number as dealer_whatsapp_number',
        'tenant_wa.whatsapp_number as dedicated_whatsapp_number',
        'assigned_agent.phone as assigned_agent_phone',
        'assigned_agent.name as assigned_agent_name',
        'creator.phone as creator_phone'
      )
      // 'awaiting_approval' included alongside 'active' so the agent who
      // just texted this listing in via WhatsApp can view the exact same
      // page (before approving it) that buyers will later see — see
      // agentIntakeWorker.js's sendPreviewAndAwaitApproval. Only reachable
      // via the exact slug (nothing lists/discovers non-active listings),
      // and logVisit/capturePublicLead below deliberately stay
      // 'active'-only so a pre-approval preview tap never counts as a
      // buyer visit or creates a lead.
      .where({ 'listings.public_slug': slug })
      .whereIn('listings.status', ['active', 'awaiting_approval'])
      .first();

    if (!listing) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'This property listing is no longer available or active.'
        }
      });
    }

    // 2. Fetch the associated visual media mapping data blocks
    const media = await knex('listing_media')
      .select('satellite_image_url', 'streetview_image_url', 'photo_urls')
      .where({ listing_id: listing.id })
      .first();

    // 3. Fetch surrounding key landmarks sorted by walking/driving proximity
    const landmarks = await knex('listing_landmarks')
      .select('place_name', 'place_type', 'walk_minutes', 'drive_minutes', 'distance_meters')
      .where({ listing_id: listing.id })
      .orderBy('distance_meters', 'asc');

    // 3b. Local Intelligence — real, cited neighborhood context (news/safety/
    //    seasonal conditions). Only surfaced once generation has actually
    //    completed with real citations; null while pending/failed/no_data so
    //    the frontend can render a loading state or omit the section
    //    entirely, rather than showing an error or empty-looking block.
    const localIntel = await knex('listing_local_intelligence')
      .select('status', 'summary_json', 'citation_count', 'generated_at')
      .where({ listing_id: listing.id })
      .first();
    const localIntelligence = localIntel && localIntel.status === 'completed'
      ? { ...localIntel.summary_json, citationCount: localIntel.citation_count, generatedAt: localIntel.generated_at }
      : null;

    // 4. Dealer's WhatsApp number for the free V4 "chat with us" CTA link —
    //    this listing's assigned agent (per-listing attribution, growth/
    //    unlimited plans) takes priority if set, then the tenant's own
    //    dedicated number (Ch.12.3), else the shared platform number from env.
    const dealerWhatsappDigits = toWaMeDigits(
      listing.assigned_agent_phone || listing.creator_phone || listing.dedicated_whatsapp_number || listing.dealer_whatsapp_number || process.env.WHATSAPP_SHARED_NUMBER
    );

    // 5. Structure data matching the verified success protocol
    return res.status(200).json({
      success: true,
      listing: {
        id: listing.id,
        title: listing.title,
        raw_address: listing.raw_address,
        formatted_address: listing.formatted_address,
        lat: listing.lat != null ? parseFloat(listing.lat) : null,
        lng: listing.lng != null ? parseFloat(listing.lng) : null,
        price: listing.price,
        plot_area: listing.plot_area,
        property_type: listing.property_type,
        description: listing.description,
        status: listing.status,
        public_slug: listing.public_slug
      },
      media: media || null,
      landmarks: landmarks || [],
      localIntelligence,
      dealer: {
        businessName: listing.dealer_business_name,
        agentName: listing.assigned_agent_name || null,
        whatsappDigits: dealerWhatsappDigits || null
      }
    });

  } catch (error) {
    console.error('Failure fetching public listing aggregator:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'System failed to safely aggregate property configurations.'
      }
    });
  }
}

/**
 * Phase 3 — logs a page view against a listing. Anonymous by default
 * (lead_id null); becomes attributable retroactively once/if the same
 * browser session submits the soft phone prompt (see capturePublicLead,
 * which patches lead_id onto the visit row this returns an id for).
 */
async function logVisit(req, res) {
  const knex = req.app.get('db');
  const { slug } = req.params;
  const { referral_source, referral_lead_tag } = req.body || {};

  try {
    const listing = await knex('listings')
      .select('id')
      .where({ public_slug: slug, status: 'active' })
      .first();

    if (!listing) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'This property listing is no longer available or active.' }
      });
    }

    const [visit] = await knex('listing_visits')
      .insert({
        listing_id: listing.id,
        referral_source: referral_source || null,
        referral_lead_tag: referral_lead_tag || null,
        user_agent: req.headers['user-agent'] || null
        // ip_city intentionally left null for now — deliberately not doing
        // precise device geolocation (Ch.13.4 data minimisation); wiring up
        // a coarse city-level IP lookup here is a safe future add.
      })
      .returning(['id']);

    return res.status(201).json({ success: true, visitId: visit.id });
  } catch (error) {
    console.error('Failed to log listing visit:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to log this visit.' }
    });
  }
}

/**
 * Phase 3 (soft phone prompt) + Phase 4 (WhatsApp CTA lead capture) combined:
 * a buyer on the public page submits their name + phone. This:
 *   1. Dedupes/creates a `leads` row for this tenant+phone (Ch.11.6),
 *   2. Attaches lead_id to the originating visit row if one was passed in,
 *   3. Opens (or reuses) a `whatsapp_threads` row for this lead+listing,
 *   4. Queues a first-touch WhatsApp message onto the SAME whatsapp-outbound
 *      queue whatsappOutboundWorker.js already consumes — no new worker
 *      needed, this is the trigger that was missing per the Phase 2 brief.
 */
async function capturePublicLead(req, res) {
  const knex = req.app.get('db');
  const { slug } = req.params;
  const { name, phone, visitId } = req.body || {};

  if (!phone) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Phone number is required.' }
    });
  }

  const normalizedPhone = normalizePhone(phone);

  try {
    // Same join/priority as getPublicListing (above) — this listing's
    // assigned agent (per-listing attribution, growth/unlimited plans)
    // takes priority over the tenant's own number for WHO the automated
    // first-touch message should be attributed to, exactly like the
    // "Get full details on WhatsApp" CTA already resolves it.
    const listing = await knex('listings')
      .join('tenants', 'listings.tenant_id', 'tenants.id')
      .leftJoin('users as assigned_agent', 'listings.assigned_agent_id', 'assigned_agent.id')
      .leftJoin('users as creator', 'listings.created_by', 'creator.id')
      .leftJoin('whatsapp_numbers as tenant_wa', function () {
        this.on('tenant_wa.tenant_id', '=', 'listings.tenant_id')
            .andOnVal('tenant_wa.is_default', '=', true);
      })
      .select(
        'listings.id',
        'listings.tenant_id',
        'listings.title',
        'listings.price',
        'listings.public_slug',
        'tenants.whatsapp_number as dealer_whatsapp_number',
        'tenant_wa.whatsapp_number as dedicated_whatsapp_number',
        'assigned_agent.phone as assigned_agent_phone',
        'assigned_agent.name as assigned_agent_name',
        'creator.phone as creator_phone'
      )
      .where({ 'listings.public_slug': slug, 'listings.status': 'active' })
      .first();

    if (!listing) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'This property listing is no longer available or active.' }
      });
    }

    const { id: listingId, tenant_id: tenantId } = listing;
    const attributedAgentName = listing.assigned_agent_name || null;
    const attributedAgentPhone = normalizePhone(listing.assigned_agent_phone || listing.creator_phone || listing.dedicated_whatsapp_number || listing.dealer_whatsapp_number || '') || null;

    // 1. Dedupe by tenant + phone (Ch.11.6) — one lead record per person per tenant,
    //    not per listing, so repeat interest across listings rolls up correctly.
    let lead = await knex('leads')
      .where({ tenant_id: tenantId, phone: normalizedPhone })
      .first();

    if (lead) {
      await knex('leads')
        .where({ id: lead.id })
        .update({
          name: name ? name.trim() : lead.name,
          updated_at: knex.fn.now()
        });
    } else {
      const [newLead] = await knex('leads')
        .insert({
          tenant_id: tenantId,
          name: name ? name.trim() : null,
          phone: normalizedPhone,
          source: 'soft_prompt',
          status: 'new'
        })
        .returning(['id', 'name', 'phone']);
      lead = newLead;
    }

    // 2. Attach this identified lead to the originating (previously anonymous) visit
    if (visitId) {
      await knex('listing_visits')
        .where({ id: visitId, listing_id: listingId })
        .update({ lead_id: lead.id });
    }

    // 3. Open or reuse a WhatsApp thread for this lead+listing
    let thread = await knex('whatsapp_threads')
      .where({ tenant_id: tenantId, lead_id: lead.id, listing_id: listingId, status: 'open' })
      .first();

    if (!thread) {
      const [newThread] = await knex('whatsapp_threads')
        .insert({
          tenant_id: tenantId,
          lead_id: lead.id,
          listing_id: listingId,
          status: 'open',
          service_window_expires_at: knex.raw("NOW() + INTERVAL '24 hours'")
        })
        .returning(['id']);
      thread = newThread;
    }

    // 4. Queue the first-touch message — same shape whatsappOutboundWorker.js
    //    already expects from vocallmWorker.js, so no worker changes needed.
    const formattedPrice = listing.price != null
      ? new Intl.NumberFormat('en-IN', {
          style: 'currency',
          currency: 'INR',
          maximumFractionDigits: 0
        }).format(listing.price)
      : null;

    // Attribute the follow-up to the same agent/dealer "Get full details on
    // WhatsApp" already resolves (assigned_agent_phone || dealer_whatsapp_
    // number), so the buyer knows who to expect and can reach them directly
    // — the Meta Cloud API send itself always goes out via this platform's
    // one connected number (see whatsappOutboundWorker.js), so the ONLY way
    // this message can be attributed to the right person is by naming them
    // and giving their direct number in the body.
    const followUpFrom = attributedAgentName
      ? `${attributedAgentName}${attributedAgentPhone ? ` (${attributedAgentPhone})` : ''}`
      : (attributedAgentPhone || null);

    const firstTouchMessage = formattedPrice
      ? `Hi${lead.name ? ' ' + lead.name : ''}! Thanks for your interest in "${listing.title}" ` +
        `(${formattedPrice}). ${followUpFrom ? `${followUpFrom} will` : 'Our team will'} follow up shortly ` +
        `with more details — feel free to ask anything about the property here on WhatsApp in the meantime.`
      : `Hi${lead.name ? ' ' + lead.name : ''}! Thanks for your interest in "${listing.title}". ` +
        `${followUpFrom ? `${followUpFrom} will` : 'Our team will'} follow up shortly with more details, ` +
        `including pricing — feel free to ask anything about the property here on WhatsApp in the meantime.`;

    await whatsappOutboundQueue.add('send-first-touch', {
      tenantId,
      threadId: thread.id,
      leadId: lead.id,
      phone: normalizedPhone,
      leadName: lead.name || 'Customer',
      propertyTitle: listing.title,
      messageBody: firstTouchMessage,
      attributedAgentName,
      attributedAgentPhone
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });

    return res.status(201).json({
      success: true,
      message: 'Thanks — our team will reach out on WhatsApp shortly.',
      leadId: lead.id,
      threadId: thread.id
    });

  } catch (error) {
    console.error('Failed to capture public lead:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to submit your details. Please try again.' }
    });
  }
}

/**
 * PATCH /api/v1/public/listings/:slug/location
 * Lets a dealer manually drag the map pin to the exact spot before
 * approving, when the AI's geocode is close but not quite right (a
 * plot corner, an address Google can't pin precisely even with a PIN
 * code). Pre-approval only — see the status check below.
 *
 * This route is public/unauthenticated, same as the rest of this
 * controller (no login on this channel, matching the WhatsApp-style
 * intake flow) — a listing's public_slug is the only thing gating
 * access to it. That's an acceptable trust model for a not-yet-
 * published draft (functionally no different from anyone who already
 * has the preview link being able to approve/edit it via the chat
 * itself), but would NOT be acceptable once a listing is live — any
 * visitor with the link could then silently relocate a published
 * listing. Hence the hard block on status === 'active' below.
 */
async function updateListingLocation(req, res) {
  const knex = req.app.get('db');
  const { slug } = req.params;
  const { lat, lng } = req.body || {};

  const nLat = typeof lat === 'number' ? lat : parseFloat(lat);
  const nLng = typeof lng === 'number' ? lng : parseFloat(lng);

  if (!Number.isFinite(nLat) || !Number.isFinite(nLng) || nLat < -90 || nLat > 90 || nLng < -180 || nLng > 180) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'lat and lng must be valid coordinates.' }
    });
  }

  try {
    const listing = await knex('listings').where({ public_slug: slug }).first();
    if (!listing) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'This property listing is no longer available or active.' }
      });
    }

    if (listing.status === 'active') {
      return res.status(409).json({
        error: { code: 'ALREADY_PUBLISHED', message: 'This listing is already live — its location can no longer be adjusted this way.' }
      });
    }

    const config = await knex('tenant_configs').where({ tenant_id: listing.tenant_id }).first();
    const targetApiKey = config?.google_maps_api_key_override || process.env.GOOGLE_MAPS_API_KEY;

    if (!targetApiKey) {
      return res.status(500).json({
        error: { code: 'NO_API_KEY', message: 'Maps configuration is missing for this account.' }
      });
    }

    // Best-effort reverse geocode so the displayed address stays roughly
    // consistent with the manually-corrected point. Not fatal if this
    // fails — the coordinates are still the dealer's explicit correction
    // regardless of whether a nice address string comes back for them;
    // falls back to whatever address the listing already had.
    let formattedAddress = null;
    try {
      const reverseUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${nLat},${nLng}&key=${targetApiKey}`;
      const reverseResponse = await axios.get(reverseUrl, { timeout: 8000 });
      if (reverseResponse.data.status === 'OK' && reverseResponse.data.results.length) {
        formattedAddress = reverseResponse.data.results[0].formatted_address;
      }
    } catch (reverseErr) {
      console.error('Reverse geocode for manual pin correction failed (non-fatal):', reverseErr.message);
    }

    // Deliberately no extraListingUpdates — status is left exactly as-is
    // (already 'pending' or 'awaiting_approval', which is why this was
    // even allowed above). Only geoEnrichmentWorker.js's own job decides
    // status transitions. pin_manually_corrected=true is set here though —
    // it's what tells the approval step (agentIntakeController.js) not to
    // also record an 'implicit_approval' cache entry, since this explicit
    // correction already recorded the stronger 'manual_pin_drag' one below.
    await applyResolvedLocation(knex, {
      listingId: listing.id,
      lat: nLat,
      lng: nLng,
      formattedAddress,
      targetApiKey,
      propertyType: listing.property_type,
      extraListingUpdates: { pin_manually_corrected: true },
    });

    // Self-learning cache: a dealer just explicitly confirmed this is the
    // right spot for this building/locality — worth remembering for the
    // NEXT listing that names the same building/society/locality. See
    // resolvedLocalityService.js / migration 20260828_04.
    await recordResolvedLocality(knex, {
      tenantId: listing.tenant_id,
      buildingName: listing.building_name,
      rawAddress: listing.raw_address,
      lat: nLat,
      lng: nLng,
      formattedAddress,
      source: 'manual_pin_drag',
    });

    return res.status(200).json({
      success: true,
      lat: nLat,
      lng: nLng,
      formatted_address: formattedAddress || listing.formatted_address,
    });
  } catch (error) {
    console.error('Failed to update listing location:', error.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update location. Please try again.' }
    });
  }
}

module.exports = { getPublicListing, logVisit, capturePublicLead, updateListingLocation };
