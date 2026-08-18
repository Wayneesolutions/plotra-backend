// src/services/wayneRingSyncService.js
//
// Shared correlation logic for reconciling WayneRing (aivoicebackend) call
// outcomes into Plotra's ai_voice_calls / wayne_ring_unmatched_calls tables.
// Extracted out of wayneRingCallSyncWorker.js so the same, single-tested
// implementation can be driven two ways:
//   - wayneRingCallSyncWorker.js: polls on a timer (the only mechanism that
//     existed before the receiver below), kept running indefinitely as a
//     fallback per PLOTRA_HANDOVER_FOR_SANT.md §10.8's explicit instruction
//     ("polling should stay on as a fallback for at least one full release
//     cycle" even after a webhook is wired).
//   - wayneRingWebhookController.js: triggered immediately by WayneRing's
//     call.completed webhook (aivoicebackend PR #5), so an outcome lands in
//     minutes-early instead of waiting for the next poll tick.
//
// Runs its own service-context transaction rather than trusting the caller
// to have set one: ai_voice_calls' own RLS policy is permissive when no
// tenant context is set (same "Phase 5" shape as the rest of that
// migration), but the leads/tenant_configs tables this joins/writes into
// were tightened to deny-by-default in 20260708_01_plans_rls_fix_password_reset.js
// (STRICT_TABLES) — without this, the leads join below silently returns zero
// rows against a non-bypassrls DB role. Same rationale, same pattern, as
// authController.js's forgotPassword/resetPassword (a legitimate
// cross-tenant lookup with its own independent gate — here, that gate is
// "this only runs from a trusted poller or a signature-verified webhook",
// not tenant matching).
const { listCalls, listInboundCalls } = require('./wayneRingService');
const { normalizePhone } = require('../utils/phone');

const MATCH_WINDOW_HOURS = 6; // how long after an outbound call was triggered we'll still consider a WayneRing record a match

// Only finalize sync once a call has actually ended — matching a call that's
// still RINGING/IN_PROGRESS would write a synced_at with no real outcome yet.
const TERMINAL_CALL_STATUSES = new Set(['COMPLETED', 'NO_ANSWER', 'FAILED', 'VOICEMAIL']);

/**
 * Matches pending outbound anchor rows against WayneRing's call list.
 *
 * Anchors created by wayneRingService.callLeadNow (aivoicebackend PR #5)
 * already carry provider_call_id — set synchronously when the call was
 * placed, straight from WayneRing's response — so those match exactly by
 * id, no guessing involved.
 *
 * Anchors from the old CSV/campaign flow this replaced have no
 * provider_call_id yet and fall back to matching by phone number + a time
 * window after the anchor was created. Kept for any such rows already in
 * flight; new calls no longer go through that path.
 */
async function syncOutboundCalls(knex) {
  return knex.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.is_service_context', 'true', true)");

    const pendingAnchors = await trx('ai_voice_calls as c')
      .join('leads as ld', 'c.lead_id', 'ld.id')
      .select('c.id', 'c.called_at', 'c.provider_call_id', 'ld.phone')
      .where({ 'c.provider': 'wayneRing', 'c.direction': 'outbound' })
      .whereNull('c.synced_at');

    if (pendingAnchors.length === 0) return { matched: 0, pending: 0 };

    const calls = await listCalls();
    let matched = 0;

    for (const anchor of pendingAnchors) {
      let match;
      let correlationMethod;

      if (anchor.provider_call_id) {
        match = calls.find((call) => String(call.id) === anchor.provider_call_id);
        correlationMethod = 'direct_response';
      } else {
        const anchorPhone = normalizePhone(anchor.phone);
        match = calls.find((call) => {
          // WayneRing's GET /api/calls nests the lead's phone under call.lead.phone
          // (see calls.js's mapCall — it spreads the raw Prisma Call row, which has
          // no top-level phone field at all). The extra fallbacks are defensive only.
          const callPhone = normalizePhone(call.lead?.phone || call.phone || call.to);
          if (!callPhone || callPhone !== anchorPhone) return false;
          const callTime = new Date(call.calledAt || call.createdAt || call.startedAt);
          const anchorTime = new Date(anchor.called_at);
          if (Number.isNaN(callTime.getTime())) return false;
          const diffMs = callTime.getTime() - anchorTime.getTime();
          // small negative allowance for clock skew between the two systems
          return diffMs >= -60000 && diffMs <= MATCH_WINDOW_HOURS * 3600 * 1000;
        });
        correlationMethod = 'anchor_match';
      }

      // Don't finalize on a call that's still ringing/in-progress — wait for a
      // terminal status so outcome/duration/transcript are actually populated.
      if (!match || !TERMINAL_CALL_STATUSES.has(match.status)) continue;

      await trx('ai_voice_calls').where({ id: anchor.id }).update({
        outcome: match.outcome || null,
        duration_seconds: match.durationSeconds ?? match.duration_seconds ?? null,
        recording_url: match.recordingUrl || match.recording_url || null,
        transcript_summary: match.summary || match.transcript_summary || null,
        provider_call_id: String(match.id),
        correlation_method: correlationMethod,
        synced_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
      matched++;
    }

    return { matched, pending: pendingAnchors.length - matched };
  });
}

/**
 * WayneRing has no concept of Plotra tenants/leads at all — an inbound call
 * only reaches Plotra's DB by resolving which dealer's forwarded number it
 * came in on (tenant_configs.wayne_ring_inbound_number_id), then matching/
 * creating a lead by the caller's phone. If the number can't be resolved to
 * a tenant, the call is NOT silently dropped — it's recorded in
 * wayne_ring_unmatched_calls for manual reconciliation, since ai_voice_calls
 * structurally requires a tenant_id (correctly, for every other row in it).
 */
async function syncInboundCalls(knex) {
  return knex.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.is_service_context', 'true', true)");

    const calls = await listInboundCalls();
    let created = 0;
    let unmatched = 0;
    let alreadyKnown = 0;

    for (const call of calls) {
      const providerCallId = String(call.id);

      const existing = await trx('ai_voice_calls').where({ provider_call_id: providerCallId }).first();
      if (existing) { alreadyKnown++; continue; }
      const existingUnmatched = await trx('wayne_ring_unmatched_calls').where({ provider_call_id: providerCallId }).first();
      if (existingUnmatched) { alreadyKnown++; continue; }

      const calledNumberId = call.phoneNumberId || call.toNumberId || call.numberId || null;
      const tenantConfig = calledNumberId
        ? await trx('tenant_configs').where({ wayne_ring_inbound_number_id: calledNumberId }).first()
        : null;

      const callerPhoneRaw = call.callerPhone || call.from || call.phone;

      if (!tenantConfig) {
        await trx('wayne_ring_unmatched_calls').insert({
          provider_call_id: providerCallId,
          caller_phone: callerPhoneRaw ? normalizePhone(callerPhoneRaw) : null,
          called_number_id: calledNumberId,
          raw_call_data: JSON.stringify(call),
          call_started_at: call.startedAt || call.createdAt || null,
        });
        unmatched++;
        continue;
      }

      const callerPhone = normalizePhone(callerPhoneRaw);
      let lead = await trx('leads').where({ tenant_id: tenantConfig.tenant_id, phone: callerPhone }).first();
      if (!lead) {
        [lead] = await trx('leads').insert({
          tenant_id: tenantConfig.tenant_id,
          phone: callerPhone,
          source: 'ai_call_inbound',
          status: 'new',
        }).returning(['id']);
      }

      await trx('ai_voice_calls').insert({
        tenant_id: tenantConfig.tenant_id,
        lead_id: lead.id,
        direction: 'inbound',
        provider: 'wayneRing',
        outcome: call.outcome || null,
        duration_seconds: call.durationSeconds ?? call.duration_seconds ?? null,
        recording_url: call.recordingUrl || call.recording_url || null,
        transcript_summary: call.summary || call.transcript_summary || null,
        called_at: call.startedAt || call.createdAt || trx.fn.now(),
        provider_call_id: providerCallId,
        correlation_method: 'phone_time_match',
        synced_at: trx.fn.now(),
      });
      created++;
    }

    return { created, unmatched, alreadyKnown };
  });
}

module.exports = { syncOutboundCalls, syncInboundCalls, MATCH_WINDOW_HOURS, TERMINAL_CALL_STATUSES };
