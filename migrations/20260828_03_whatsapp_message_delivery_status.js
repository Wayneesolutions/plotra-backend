/**
 * Before this, an outbound WhatsApp send that failed permanently (24h
 * session window closed with no template to fall back to, BSP rejection,
 * etc.) left literally no trace anywhere a human could see — only a
 * console.error in whatsappOutboundWorker.js's 'failed' handler. This
 * column lets a failed/blocked send still get logged to whatsapp_messages
 * (so it shows up in the thread/dashboard) instead of vanishing.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('whatsapp_messages', (table) => {
    // 'sent' (default, normal free-form send), 'template_sent' (sent as a
    // template because the 24h window was closed), 'failed' (blocked/
    // rejected — window closed and no template configured, or BSP error).
    table.string('delivery_status', 20).notNullable().defaultTo('sent');
    table.text('delivery_failure_reason').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('whatsapp_messages', (table) => {
    table.dropColumn('delivery_status');
    table.dropColumn('delivery_failure_reason');
  });
};
