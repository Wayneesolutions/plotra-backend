/**
 * Adds a small counter so agentIntakeController.js can tell "the dealer's
 * first non-informative reply while awaiting approval" apart from "the
 * SECOND one in a row" — the generic reminder line is fine once, but
 * repeating it identically after the dealer already tried once (e.g. "it's
 * wrong" then "how do I fix it") reads as the bot being stuck, so the
 * second+ reply switches to a more explicit message that asks for the
 * actual corrected value. Reset to 0 whenever the draft gets real,
 * extractable info (a genuine correction) or a fresh draft starts.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.integer('noninformative_reply_count').notNullable().defaultTo(0);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.dropColumn('noninformative_reply_count');
  });
};
