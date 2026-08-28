// src/controllers/webChatCodeController.js
//
// Owner-facing endpoints for the tenant's web chat activation code — the
// code an owner hands to whoever embeds the public chat widget
// (ChatWidget.jsx, POST /api/v1/chat/web/activate) on their own site.
const { generateUniqueWebChatCode } = require('../utils/webChatCode');

/**
 * GET /api/v1/dashboard/web-chat-code
 * Generates one lazily on first request if this tenant doesn't have one
 * yet — covers every tenant-creation path (request approval, direct admin
 * creation, WhatsApp signup) without needing to patch each one to
 * generate a code at insert time.
 */
async function getWebChatCode(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;

  if (role !== 'owner') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only tenant owners can view the web chat activation code.' }
    });
  }

  try {
    const tenant = await knex('tenants').where({ id: tenant_id }).first();
    if (!tenant) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tenant not found.' } });
    }

    let code = tenant.web_chat_code;
    if (!code) {
      code = await generateUniqueWebChatCode(knex);
      await knex('tenants').where({ id: tenant_id }).update({ web_chat_code: code, updated_at: knex.fn.now() });
    }

    return res.status(200).json({ success: true, code });
  } catch (error) {
    console.error('Failed to fetch web chat code:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch the web chat code.' } });
  }
}

/**
 * POST /api/v1/dashboard/web-chat-code/regenerate
 * Rotates the code — the old one stops working immediately (whatever
 * widget instance had it embedded will need the new one re-entered).
 */
async function regenerateWebChatCode(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;

  if (role !== 'owner') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Only tenant owners can regenerate the web chat activation code.' }
    });
  }

  try {
    const code = await generateUniqueWebChatCode(knex);
    const [updated] = await knex('tenants')
      .where({ id: tenant_id })
      .update({ web_chat_code: code, updated_at: knex.fn.now() })
      .returning(['id']);

    if (!updated) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tenant not found.' } });
    }

    return res.status(200).json({ success: true, code });
  } catch (error) {
    console.error('Failed to regenerate web chat code:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to regenerate the web chat code.' } });
  }
}

module.exports = { getWebChatCode, regenerateWebChatCode };
