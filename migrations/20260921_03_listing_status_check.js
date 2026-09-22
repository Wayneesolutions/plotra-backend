/**
 * Monthly listing status check + auto-delete (PR 4).
 *
 * All four new columns are nullable/defaulted so every existing listing
 * behaves exactly as before this migration until the cron actually reaches
 * it — nothing is retroactively flagged or hidden.
 *
 * - status_check_sent_at: when the current 30-day cycle's "still
 *   available?" prompt was sent. Doubles as the per-cycle anchor —
 *   re-derived fresh each cron run rather than a separate cycle-number
 *   column, same "derive, don't store" approach as PR 2's
 *   getCycleAnchorDate.
 * - status_check_reminder_sent_at: when the 3-day-later reminder fired —
 *   prevents resending it daily between day 3 and day 7 of a cycle.
 * - last_confirmed_at: bumped on a "Still Available" reply. Compared
 *   against status_check_sent_at to tell "answered this cycle" apart from
 *   "answered a previous cycle, still hasn't replied to this one."
 * - deleted_at: soft-delete timestamp, set alongside status='sold' — see
 *   PR spec's own recommendation, confirmed by the user. No hard-delete
 *   path exists; nothing in this codebase drops a listings row.
 *
 * No new status enum is enforced at the DB level — 'sold' and
 * 'unconfirmed' are just additional string values, same convention as
 * every other status column in this codebase (plain varchar, no CHECK
 * constraint — see agent_listing_drafts.status, tenant_requests.status).
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.timestamp('last_confirmed_at').nullable();
    table.timestamp('status_check_sent_at').nullable();
    table.timestamp('status_check_reminder_sent_at').nullable();
    table.timestamp('deleted_at').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('last_confirmed_at');
    table.dropColumn('status_check_sent_at');
    table.dropColumn('status_check_reminder_sent_at');
    table.dropColumn('deleted_at');
  });
};
