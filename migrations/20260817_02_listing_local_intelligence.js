/**
 * "Local Intelligence" — real, cited neighborhood context per listing
 * (recent local news, safety, seasonal conditions like monsoon flooding),
 * generated via OpenAI's web-search-grounded Responses API, never invented.
 *
 * 1:1 with listings, no tenant_id/RLS — protected indirectly via the
 * listing_id FK, same precedent as agent_draft_messages
 * (see 20260817_01_agent_whatsapp_listing_intake.js).
 */

exports.up = async function (knex) {
  await knex.schema.createTable('listing_local_intelligence', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('listing_id')
         .notNullable()
         .unique()
         .references('id')
         .inTable('listings')
         .onDelete('CASCADE');

    // pending -> completed / failed / no_data (no reliable web results found —
    // distinct from failed, which means the API call itself errored)
    table.string('status', 20).notNullable().defaultTo('pending');

    // { news: [{text, source_url, source_title}], safety: [...], seasonal: [...] }
    // Every item is guaranteed (by app-code filtering, not just the prompt) to
    // carry a real source_url before this gets written — see
    // groundedResearchService.filterCitedItems().
    table.jsonb('summary_json');

    // Audit trail — the model's unparsed output, kept for debugging a bad
    // generation without needing to re-run the (costly) web search.
    table.text('raw_response_text');
    table.string('model', 50).defaultTo('gpt-4o-mini');
    table.integer('citation_count').defaultTo(0);
    table.text('error_message');

    table.timestamp('generated_at');
    // Unused in v1 (no refresh scanner yet) — present now so adding one later
    // needs no further migration.
    table.timestamp('next_refresh_at');
    table.timestamps(true, true);

    table.index(['next_refresh_at'], 'idx_local_intel_refresh');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('listing_local_intelligence');
};
