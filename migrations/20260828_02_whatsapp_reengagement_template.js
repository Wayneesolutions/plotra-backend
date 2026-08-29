/**
 * WhatsApp Business Platform rule: once 24h have passed since the customer's
 * last inbound message, a business can ONLY send a pre-approved template
 * message, not free-form text — Meta rejects free-form sends outside that
 * window. whatsappOutboundWorker.js was sending free-form `type: 'text'`
 * unconditionally, with nothing checking whatsapp_threads.service_window_
 * expires_at first, so any reply attempted after the window closed was
 * silently rejected by Meta and eventually failed permanently after
 * retries — retries don't help here, the window doesn't reopen on its own.
 *
 * Nullable per-tenant override for the approved template name/language to
 * use for a re-engagement send once the window has closed. Falls back to
 * WHATSAPP_REENGAGEMENT_TEMPLATE_NAME/_LANG env vars (a platform-wide
 * default template) when a tenant hasn't configured their own — see
 * whatsappOutboundWorker.js.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('tenant_configs', (table) => {
    table.string('whatsapp_reengagement_template_name', 100).nullable();
    table.string('whatsapp_reengagement_template_lang', 10).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('tenant_configs', (table) => {
    table.dropColumn('whatsapp_reengagement_template_name');
    table.dropColumn('whatsapp_reengagement_template_lang');
  });
};
