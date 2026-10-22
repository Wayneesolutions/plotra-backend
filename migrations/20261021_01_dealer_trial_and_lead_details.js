/**
 * Dealer model + trial (21 Oct 2026 decisions).
 *
 * - users.trial_ends_at: set when a WhatsApp joiner is approved as a new
 *   dealer (7-day free trial). Null for everyone else, so existing users and
 *   sub-dealers are untouched by the trial logic in paymentReminderWorker.js.
 * - users.trial_reminder_day: last trial reminder sent (days left), so the
 *   daily worker never sends the same reminder twice after a restart.
 * - leads.details: what the lead wants (from a seller lead the super admin
 *   forwards), shown in the dealer's lead inbox and WhatsApp alert.
 *
 * Additive only; `down` reverses it.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.timestamp('trial_ends_at').nullable();
    table.integer('trial_reminder_day').nullable();
  });
  await knex.schema.alterTable('leads', (table) => {
    table.text('details').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('leads', (table) => {
    table.dropColumn('details');
  });
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('trial_reminder_day');
    table.dropColumn('trial_ends_at');
  });
};
