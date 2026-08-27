/**
 * Web chat activation codes — replaces the single hardcoded
 * WEB_CHAT_TENANT_ID/WEB_CHAT_AGENT_USER_ID env-var pair (which only ever
 * let ONE tenant use the public web chat widget per backend deployment)
 * with a per-tenant, human-typeable code. A tenant enters their own code
 * once into the widget (see ChatWidget.jsx / POST /api/v1/chat/web/activate
 * in plotra-frontend) to activate it for their account — see
 * webChatController.js's resolveWebChatIdentity, which now resolves by
 * code first and only falls back to the old env vars when no code is
 * sent, so an existing single-tenant deployment keeps working unchanged.
 *
 * Codes aren't backfilled here for existing tenants — they're generated
 * lazily (webChatCodeController.js) the first time an owner asks for
 * theirs, which covers every tenant-creation path (request approval,
 * direct admin creation, WhatsApp signup) without having to patch each
 * one by hand.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('tenants', (table) => {
    table.string('web_chat_code', 20).nullable();
  });

  // Partial unique index — only enforced once a tenant actually has a
  // code, so existing NULL rows don't collide with each other.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_tenants_web_chat_code ON tenants (web_chat_code) WHERE web_chat_code IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_tenants_web_chat_code`);
  await knex.schema.alterTable('tenants', (table) => {
    table.dropColumn('web_chat_code');
  });
};
