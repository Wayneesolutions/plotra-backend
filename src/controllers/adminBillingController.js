// src/controllers/adminBillingController.js
//
// Super-admin views for the 22 Oct billing work (mounted in routes/admin.js,
// authGuard + adminGuard + serviceContext already applied there):
//
//   GET  /api/v1/admin/whatsapp-template-sends      every template send with
//                                                   Meta's message id and error
//   GET  /api/v1/admin/payment-links                Razorpay links we created
//   POST /api/v1/admin/dealers/:userId/payment-link create (and optionally
//                                                   WhatsApp) a link for a plan
//   GET  /api/v1/admin/whatsapp-templates           the templates Plotraa uses,
//                                                   their names and variable counts

const razorpay = require('../services/razorpayService');
const { PLOTRAA_TEMPLATES, EXISTING_TEMPLATES, templateName } = require('../services/whatsappTemplates');
const { getContactVariant } = require('../services/contactVariantService');
const { t } = require('../utils/i18n');

const enqueueWhatsapp = (...a) => require('../services/agentMessagingService').enqueueAgentWhatsappSend(...a);

/** GET /api/v1/admin/whatsapp-template-sends?status=failed&phone=&limit=&offset= */
async function listTemplateSends(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    let q = knex('whatsapp_template_sends').orderBy('created_at', 'desc').limit(limit).offset(offset);
    if (req.query.status) q = q.where({ status: String(req.query.status) });
    if (req.query.phone) q = q.where('phone', 'like', `%${String(req.query.phone).replace(/\D/g, '')}%`);
    if (req.query.template) q = q.where({ template_name: String(req.query.template) });
    const [sends, counts] = await Promise.all([
      q,
      knex('whatsapp_template_sends').groupBy('status').select('status').count('id as count'),
    ]);
    const byStatus = {};
    for (const r of counts) byStatus[r.status] = Number(r.count);
    return res.json({ success: true, byStatus, sends });
  } catch (error) {
    console.error('Failed to list template sends:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load template sends.' } });
  }
}

/** GET /api/v1/admin/whatsapp-templates */
async function listTemplates(req, res) {
  const plotraa = Object.entries(PLOTRAA_TEMPLATES).map(([key, d]) => ({
    key, name: templateName(key), category: d.category, variables: d.params, variable_count: d.params.length, body: d.body,
  }));
  const existing = Object.entries(EXISTING_TEMPLATES).map(([key, d]) => ({
    key, name: process.env[d.env] || null, env: d.env, variable_count: d.bodyParams, buttons: d.buttons, source: d.source,
  }));
  return res.json({ success: true, templates: plotraa, existing });
}

/** GET /api/v1/admin/payment-links?status= */
async function listPaymentLinks(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    let q = knex('razorpay_payment_links as l')
      .join('users as u', 'u.id', 'l.user_id')
      .leftJoin('plans as p', 'p.key', 'l.plan_key')
      .select('l.id', 'l.plan_key', 'p.label as plan_label', 'l.amount_inr', 'l.short_url', 'l.status', 'l.razorpay_payment_id',
        'l.created_at', 'l.expires_at', 'l.paid_at', 'u.id as user_id', 'u.name as user_name', 'u.phone as user_phone')
      .orderBy('l.created_at', 'desc').limit(limit);
    if (req.query.status) q = q.where('l.status', String(req.query.status));
    return res.json({ success: true, enabled: razorpay.isConfigured(), links: await q });
  } catch (error) {
    console.error('Failed to list payment links:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load payment links.' } });
  }
}

/**
 * POST /api/v1/admin/dealers/:userId/payment-link
 * Body: { plan_key?, send?: boolean } - plan defaults to the dealer's chosen
 * plan, else the plan their account runs on. send=true also WhatsApps it.
 */
async function createDealerPaymentLink(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { userId } = req.params;
  if (!razorpay.isConfigured()) {
    return res.status(503).json({ error: { code: 'ONLINE_PAYMENT_UNAVAILABLE', message: 'Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).' } });
  }
  try {
    const user = await knex('users').where({ id: userId }).first('id', 'name', 'phone', 'tenant_id', 'selected_plan_key', 'role');
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    const tenant = await knex('tenants').where({ id: user.tenant_id }).first('plan');
    const planKey = req.body?.plan_key || user.selected_plan_key || tenant?.plan;
    if (!planKey) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No plan to bill: pass plan_key.' } });

    const { url, plan } = await razorpay.getOrCreatePaymentLink(knex, { user, planKey });
    if (req.body?.plan_key) await knex('users').where({ id: user.id }).update({ selected_plan_key: plan.key, updated_at: knex.fn.now() });

    let sent = false;
    if (req.body?.send && user.phone) {
      const v = await getContactVariant(knex, user.phone);
      await enqueueWhatsapp({
        tenantId: user.tenant_id,
        phone: user.phone,
        messageBody: t('plan_selected_link', v, { plan: plan.label, price: Number(plan.price_inr).toLocaleString('en-IN'), link: url }),
      });
      sent = true;
    }
    return res.json({ success: true, url, plan: { key: plan.key, label: plan.label, price_inr: plan.price_inr }, sent });
  } catch (error) {
    if (/Unknown or inactive plan/.test(error.message)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.message } });
    }
    console.error('Failed to create dealer payment link:', error.response?.data || error.message);
    return res.status(502).json({ error: { code: 'PAYMENT_LINK_FAILED', message: 'Could not create the payment link.' } });
  }
}

module.exports = { listTemplateSends, listTemplates, listPaymentLinks, createDealerPaymentLink };
