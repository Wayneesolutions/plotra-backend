// src/services/resolvedLocalityService.js
//
// Self-learning location cache — see migration 20260828_04 for the full
// design rationale. Two entry points:
//   - lookupResolvedLocality(): checked BEFORE calling Google's Geocoding
//     API (geoEnrichmentWorker.js) — a hit skips Google entirely.
//   - recordResolvedLocality(): called after a human confirms a location is
//     correct, either by manually dragging the pin
//     (publicListingController.js) or by approving a listing without
//     touching the pin (agentIntakeController.js).

function normalizeKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Checks the cache for a building_name match first (a specific named
 * project/society is a much stronger, less ambiguous key than a general
 * locality string), falling back to a raw_address match. Returns null on a
 * miss — callers fall through to the normal Google geocode flow unchanged,
 * this is purely an optimization/accuracy layer in front of it, never a
 * blocker.
 */
async function lookupResolvedLocality(knex, { tenantId, buildingName, rawAddress }) {
  if (buildingName) {
    const byBuilding = await knex('resolved_localities')
      .where({ tenant_id: tenantId, key_type: 'building_name', normalized_key: normalizeKey(buildingName) })
      .first();
    if (byBuilding) return byBuilding;
  }

  if (rawAddress) {
    const byAddress = await knex('resolved_localities')
      .where({ tenant_id: tenantId, key_type: 'raw_address', normalized_key: normalizeKey(rawAddress) })
      .first();
    if (byAddress) return byAddress;
  }

  return null;
}

/**
 * Upserts a confirmed location into the cache. Records BOTH keys when both
 * are available (building_name AND raw_address) — a listing naming "Hero
 * Homes South City" in "Ludhiana" teaches the cache two independently
 * useful things: the building's own coordinates, and that "Ludhiana" (as
 * plain locality text on its own, from a different dealer who doesn't name
 * the building) also resolves near here.
 *
 * source: 'manual_pin_drag' always wins over an existing 'implicit_approval'
 * entry for the same key (a human explicitly correcting the pin is a
 * stronger signal than one who simply didn't object to the AI's guess) —
 * the reverse never happens, an implicit_approval call is a no-op against
 * an existing manual_pin_drag entry beyond bumping confidence/last_confirmed_at.
 * A repeat manual_pin_drag (e.g. corrected again later) always overwrites
 * the coordinates outright — the most recent explicit correction wins.
 */
async function recordResolvedLocality(knex, { tenantId, buildingName, rawAddress, lat, lng, formattedAddress, source }) {
  const keys = [];
  if (buildingName) keys.push({ keyType: 'building_name', displayName: buildingName });
  if (rawAddress) keys.push({ keyType: 'raw_address', displayName: rawAddress });

  for (const { keyType, displayName } of keys) {
    const normalizedKey = normalizeKey(displayName);
    if (!normalizedKey) continue;

    const existing = await knex('resolved_localities')
      .where({ tenant_id: tenantId, key_type: keyType, normalized_key: normalizedKey })
      .first();

    if (!existing) {
      await knex('resolved_localities').insert({
        id: knex.raw('uuid_generate_v4()'),
        tenant_id: tenantId,
        key_type: keyType,
        normalized_key: normalizedKey,
        display_name: displayName,
        lat, lng,
        formatted_address: formattedAddress || null,
        source,
        confidence: 1,
        last_confirmed_at: knex.fn.now(),
      });
      continue;
    }

    // An implicit_approval confirming an existing manual_pin_drag entry
    // just bumps confidence/recency — never downgrades the trusted
    // coordinates a human explicitly set.
    const shouldOverwriteCoords = source === 'manual_pin_drag' || existing.source !== 'manual_pin_drag';

    await knex('resolved_localities')
      .where({ id: existing.id })
      .update({
        ...(shouldOverwriteCoords ? { lat, lng, formatted_address: formattedAddress || null, source } : {}),
        confidence: existing.confidence + 1,
        last_confirmed_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
  }
}

module.exports = { lookupResolvedLocality, recordResolvedLocality, normalizeKey, recordImplicitApprovalIfUncorrected };

/**
 * Called right after a listing flips to 'active'. If the dealer never
 * manually dragged the pin (pin_manually_corrected is false), their "yes"
 * IS a real confirmation signal — the preview link they approved shows the
 * satellite map at that exact lat/lng, so approving without correcting
 * means a human looked at the map and didn't object. Recorded at
 * 'implicit_approval' trust — lower than an explicit pin drag, but still
 * real signal, and free (no extra Google/user round-trip needed). A
 * listing that WAS manually corrected already recorded the stronger
 * 'manual_pin_drag' entry at correction time (publicListingController.js) —
 * skip here to avoid a redundant (harmless, but pointless) second write.
 * Shared by every approval channel (agentIntakeController.js for WhatsApp,
 * webChatController.js for web chat) so they can't drift apart.
 */
async function recordImplicitApprovalIfUncorrected(knex, listing) {
  if (!listing || listing.pin_manually_corrected) return;
  if (listing.lat == null || listing.lng == null) return;

  try {
    await recordResolvedLocality(knex, {
      tenantId: listing.tenant_id,
      buildingName: listing.building_name,
      rawAddress: listing.raw_address,
      lat: listing.lat,
      lng: listing.lng,
      formattedAddress: listing.formatted_address,
      source: 'implicit_approval',
    });
  } catch (err) {
    // Best-effort — never let a cache-write hiccup affect the actual
    // approval/publish flow, which already succeeded by the time this runs.
    console.error('Failed to record implicit-approval resolved locality (non-fatal):', err.message);
  }
}
