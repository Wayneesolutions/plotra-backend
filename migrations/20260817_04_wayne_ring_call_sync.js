/**
 * AI call-answering + real outbound calling, via WayneRing
 * (Wayneesolutions/aivoicebackend) — a separate, existing, already-working
 * AI voice calling product from the same company, integrated with rather
 * than building telephony from scratch.
 *
 * ai_voice_calls already existed (added by the "WayneState Pro ops panel"
 * migration) as a pure data model with a read-only reporting UI — nothing
 * anywhere actually wrote to it or placed/received a real call. These
 * columns are what let src/workers/wayneRingCallSyncWorker.js actually
 * populate it for real, by polling WayneRing's API (it sends no webhook)
 * and correlating results back to Plotra's own leads/listings.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('ai_voice_calls', (table) => {
    // WayneRing's own call id, once a poll cycle matches this row to one of
    // theirs. Partial-unique: doubles as the sync worker's idempotency key
    // (a WayneRing call is only ever synced into one ai_voice_calls row).
    table.string('provider_call_id', 100);
    // anchor_match (outbound — Plotra triggered it and pre-inserted this row,
    // matched back by phone+time) / phone_time_match (inbound — no anchor
    // exists, best-effort phone+time-window match) / unmatched (a WayneRing
    // call the poller could not confidently attribute to any tenant/lead —
    // surfaced in the ops panel for manual reconciliation, not dropped).
    table.string('correlation_method', 30);
    table.timestamp('synced_at');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX idx_calls_provider_call_id ON ai_voice_calls (provider_call_id)
    WHERE provider_call_id IS NOT NULL
  `);

  await knex.schema.alterTable('tenant_configs', (table) => {
    // WayneRing's phoneNumberId for this tenant's inbound-answering number
    // (the number the dealer's carrier forwards unanswered calls to). Set
    // once per dealer during onboarding, after the number is imported and
    // an assistant activated directly in WayneRing — see the plan's
    // "manual setup" section; no Plotra admin UI for this in v1.
    table.string('wayne_ring_inbound_number_id', 100);
  });

  // ai_voice_calls.tenant_id is NOT NULL (existing constraint, correctly —
  // every real Plotra call belongs to a tenant) — but an "unmatched" inbound
  // WayneRing call is, by definition, one the sync worker could NOT resolve
  // a tenant for. It structurally cannot go in ai_voice_calls. Rather than
  // silently drop it (the plan explicitly says surface these for manual
  // reconciliation, not lose them), it lands here instead — a deliberately
  // separate, tenant-less holding table, not a workaround on the main table.
  await knex.schema.createTable('wayne_ring_unmatched_calls', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('provider_call_id', 100).notNullable().unique();
    table.string('caller_phone', 20);
    table.string('called_number_id', 100); // whatever WayneRing phoneNumberId the call came in on
    table.jsonb('raw_call_data'); // full record from WayneRing, for a human to inspect during reconciliation
    table.timestamp('call_started_at');
    table.string('resolution_status', 20).notNullable().defaultTo('unresolved'); // unresolved|resolved|ignored
    table.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('wayne_ring_unmatched_calls');

  await knex.schema.alterTable('tenant_configs', (table) => {
    table.dropColumn('wayne_ring_inbound_number_id');
  });

  await knex.raw(`DROP INDEX IF EXISTS idx_calls_provider_call_id`);

  await knex.schema.alterTable('ai_voice_calls', (table) => {
    table.dropColumn('provider_call_id');
    table.dropColumn('correlation_method');
    table.dropColumn('synced_at');
  });
};
