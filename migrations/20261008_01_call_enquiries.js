/**
 * AI call enquiries — what a buyer asked for on an inbound AI call, plus
 * the WhatsApp follow-up that sends them matching listings.
 *
 * Before this, an inbound WayneRing call only ever produced an
 * ai_voice_calls row (duration/outcome/summary) and a bare lead with a
 * phone number. Nothing read what the caller actually wanted, and nothing
 * sent them anything afterwards — the "AI answers the call, captures the
 * requirement, WhatsApps matching properties" flow stopped at the call log.
 *
 * One row per inbound call (provider_call_id is the idempotency key, same
 * id ai_voice_calls/wayne_ring_unmatched_calls already key on).
 *
 * tenant_id is NULLABLE on purpose: a call on the shared Plotraa line
 * (WAYNERING_PLATFORM_INBOUND_NUMBER_IDS) belongs to no single dealer — it
 * is the voice equivalent of a buyer messaging the shared WhatsApp number
 * (buyerSearchService.js), matched across every tenant. A call on a
 * dealer's own AI-calling number carries that dealer's tenant_id and
 * lead_id and is matched against that dealer's listings only.
 *
 * No RLS on this table — same as marketplace_lead_deliveries. Every reader
 * filters by tenant_id explicitly (dealer endpoint) or is super-admin only.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('call_enquiries', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('provider_call_id', 100).notNullable().unique();
    table.uuid('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');

    // Who called, and where to WhatsApp them. These differ whenever the
    // caller asks for listings on another number, and caller_phone can be
    // useless altogether when the call arrived through carrier forwarding
    // (the forwarding line's own number shows up instead of the buyer's).
    table.string('caller_phone', 20);
    table.string('whatsapp_phone', 20);
    table.string('buyer_name', 255);

    // What they asked for — extracted from the call transcript/summary.
    table.string('intent', 20);            // buy | rent | sell | other
    table.string('property_type', 50);     // same vocabulary as listings.property_type
    table.string('area', 255);
    table.string('budget_text', 100);
    table.string('size_text', 100);
    table.string('timeline_text', 100);
    table.boolean('whatsapp_consent');     // did the caller agree to receive listings on WhatsApp
    table.text('summary');
    table.text('recording_url');
    table.jsonb('raw_extraction');         // full model output, for QA of extraction quality

    // Listing match + WhatsApp follow-up state.
    table.integer('match_count').notNullable().defaultTo(0);
    table.specificType('matched_listing_ids', 'uuid[]');
    // pending | template_sent | listings_sent | no_match | no_whatsapp_number |
    // no_consent | not_an_enquiry | skipped_no_template | skipped_stale | failed
    table.string('whatsapp_status', 30).notNullable().defaultTo('pending');
    table.timestamp('template_sent_at');
    table.timestamp('listings_sent_at');

    table.timestamp('call_started_at');
    table.timestamps(true, true);

    table.index(['tenant_id', 'created_at'], 'idx_call_enquiries_tenant_date');
    table.index(['whatsapp_phone', 'whatsapp_status'], 'idx_call_enquiries_wa_pending');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('call_enquiries');
};
