// src/controllers/adminGeoReviewController.js
//
// Super-admin-only geo review queue for WhatsApp agent-intake listings.
//
// Why this exists: geoEnrichmentWorker.js's own Geocoding API -> Places
// text-search fallback (see that file's tryPlacesTextSearch) still
// sometimes lands on a pin that doesn't match what the agent actually
// typed, and the dealer-self-correction step (agent drags the pin on
// their own preview link before replying "yes") wasn't catching those —
// agents were approving previews without verifying the pin, or couldn't
// tell it was wrong from the address text alone. This queue inserts a
// mandatory super-admin check BEFORE the agent ever sees a preview link:
// geoEnrichmentWorker.js now parks WhatsApp-sourced listings at
// status='pending_geo_review' instead of sending the preview immediately;
// an admin corrects (or confirms) the pin here, and approving from this
// queue is what finally enqueues the 'send-preview' job that
// agentIntakeWorker.js was already sending automatically before this
// change. Nothing else about the agent-facing flow changes — from the
// agent's side this just looks like the preview link took a little
// longer to arrive.
const { Queue } = require('bullmq');
const axios = require('axios');
const { applyResolvedLocation, extractGeneralArea } = require('../services/locationResolutionService');

const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  connectTimeout: 3000,
};
const agentIntakeQueue = new Queue('agent-listing-intake', { connection: redisConnection });

/**
 * GET /api/v1/admin/listings/geo-review
 * Lists WhatsApp listings currently parked at status='pending_geo_review',
 * oldest first (so a listing doesn't sit waiting on an agent indefinitely
 * just because newer ones keep landing above it). location_low_confidence
 * is surfaced as-is rather than used to filter/sort — even a
 * "high confidence" geocode has been landing on the wrong spot per the
 * bug this queue exists to catch, so admins should still eyeball every
 * row, not just the ones the pipeline already flagged as shaky.
 */
async function listGeoReviewQueue(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

  try {
    const baseQuery = knex('listings')
      .join('tenants', 'listings.tenant_id', 'tenants.id')
      .leftJoin('agent_listing_drafts', 'agent_listing_drafts.listing_id', 'listings.id')
      .leftJoin('users as agent', 'agent_listing_drafts.user_id', 'agent.id')
      .where('listings.status', 'pending_geo_review');

    const totalRow = await baseQuery.clone().count('listings.id as count').first();
    const total = Number(totalRow.count);

    const listings = await baseQuery
      .clone()
      .select(
        'listings.id',
        'listings.title',
        'listings.raw_address',
        'listings.formatted_address',
        'listings.lat',
        'listings.lng',
        'listings.location_low_confidence',
        'listings.property_type',
        'listings.created_at',
        'tenants.id as tenant_id',
        'tenants.business_name as tenant_business_name',
        'agent.name as agent_name',
        'agent.phone as agent_phone'
      )
      .orderBy('listings.created_at', 'asc')
      .limit(limit)
      .offset((page - 1) * limit);

    return res.json({
      success: true,
      listings,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error('Failed to fetch geo-review queue:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch geo-review queue.' }
    });
  }
}

/**
 * PATCH /api/v1/admin/listings/:id/geo-review
 * Body: { lat, lng } — both optional. Approves a listing out of the
 * geo-review queue and releases the agent preview.
 *
 * - lat/lng provided: admin corrected the pin. Reverse-geocoded for a
 *   fresh formatted_address (best-effort, same as the dealer manual-
 *   correction endpoint in publicListingController.js), and
 *   pin_manually_corrected is set so downstream approval logic knows a
 *   human already placed this pin — no need to also nudge the agent to
 *   check it themselves.
 * - lat/lng omitted: admin reviewed the existing AI-placed pin and it
 *   was already correct — approved as-is, pin_manually_corrected stays
 *   false since a human confirmed rather than corrected it.
 *
 * Either way: location_low_confidence is cleared (a human just looked at
 * it), status flips pending_geo_review -> awaiting_approval (the status
 * the agent-facing flow already expects — see agentIntakeController.js),
 * and 'send-preview' is enqueued so the agent finally gets their preview
 * link, exactly like geoEnrichmentWorker.js used to do automatically
 * before this queue existed.
 */
async function approveGeoReview(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const { lat, lng } = req.body || {};

  const hasCorrection = lat !== undefined && lng !== undefined;
  let nLat, nLng;
  if (hasCorrection) {
    nLat = typeof lat === 'number' ? lat : parseFloat(lat);
    nLng = typeof lng === 'number' ? lng : parseFloat(lng);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLng) || nLat < -90 || nLat > 90 || nLng < -180 || nLng > 180) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'lat and lng must be valid coordinates.' }
      });
    }
  }

  try {
    const listing = await knex('listings').where({ id }).first();
    if (!listing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found.' } });
    }
    if (listing.status !== 'pending_geo_review') {
      return res.status(409).json({
        error: { code: 'NOT_IN_REVIEW', message: `Listing is '${listing.status}', not awaiting geo review — it may already have been approved.` }
      });
    }

    const draft = await knex('agent_listing_drafts').where({ listing_id: id }).first();
    if (!draft) {
      // Shouldn't happen — every pending_geo_review listing came from the
      // WhatsApp draftId path (see geoEnrichmentWorker.js) — but fail
      // loudly rather than silently approving a listing the agent has no
      // way to be notified about.
      return res.status(500).json({
        error: { code: 'DRAFT_NOT_FOUND', message: 'No agent-intake draft found for this listing; cannot send a preview to the agent.' }
      });
    }

    let finalLat = listing.lat;
    let finalLng = listing.lng;
    let formattedAddress = null;

    if (hasCorrection) {
      finalLat = nLat;
      finalLng = nLng;

      const config = await knex('tenant_configs').where({ tenant_id: listing.tenant_id }).first();
      const targetApiKey = config?.google_maps_api_key_override || process.env.GOOGLE_MAPS_API_KEY;
      if (targetApiKey) {
        let generalArea = null;
        try {
          const reverseUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${nLat},${nLng}&key=${targetApiKey}`;
          const reverseResponse = await axios.get(reverseUrl, { timeout: 8000 });
          if (reverseResponse.data.status === 'OK' && reverseResponse.data.results.length) {
            formattedAddress = reverseResponse.data.results[0].formatted_address;
            generalArea = extractGeneralArea(reverseResponse.data.results[0].address_components, formattedAddress);
          }
        } catch (reverseErr) {
          console.error('Reverse geocode for admin geo-review correction failed (non-fatal):', reverseErr.message);
        }

        await applyResolvedLocation(knex, {
          listingId: id,
          lat: nLat,
          lng: nLng,
          formattedAddress,
          targetApiKey,
          propertyType: listing.property_type,
          extraListingUpdates: {
            status: 'awaiting_approval',
            location_low_confidence: false,
            pin_manually_corrected: true,
            general_area: generalArea,
          },
        });
      } else {
        // No maps key configured for this tenant — still record the
        // admin's corrected coordinates rather than blocking the approval
        // on a config problem that's unrelated to this listing.
        await knex('listings').where({ id }).update({
          lat: nLat,
          lng: nLng,
          status: 'awaiting_approval',
          location_low_confidence: false,
          pin_manually_corrected: true,
          updated_at: knex.fn.now(),
        });
      }
    } else {
      // Approved as-is — just the status flip, no coordinate change.
      await knex('listings').where({ id }).update({
        status: 'awaiting_approval',
        location_low_confidence: false,
        updated_at: knex.fn.now(),
      });
    }

    await agentIntakeQueue.add('send-preview', { draftId: draft.id, listingId: id }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    return res.status(200).json({
      success: true,
      listing: { id, status: 'awaiting_approval', lat: finalLat, lng: finalLng, formatted_address: formattedAddress || listing.formatted_address },
    });
  } catch (error) {
    console.error('Failed to approve geo-review listing:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to approve listing.' }
    });
  }
}

module.exports = {
  listGeoReviewQueue,
  approveGeoReview,
};
