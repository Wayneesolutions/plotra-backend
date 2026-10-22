// src/services/supportRequestService.js
//
// "Someone needs a human." Raised by the Plotraa Assistant when an agent has
// a problem it can't solve, someone asks for a call back, or a complaint comes
// in. Creates/updates a support_requests row and alerts the team so they can
// contact the person directly. The super-admin "Support" tab works the queue.
//
// Alerts (all best-effort, none can fail the WhatsApp reply):
// - WhatsApp to every number in SUPPORT_ALERT_PHONES. A business can only send
//   free text to a number that messaged it in the last 24h, so set
//   SUPPORT_ALERT_TEMPLATE_NAME to an approved template with 3 body variables
//   ({{1}} who, {{2}} phone, {{3}} what) for alerts that always arrive.
// - Email to SUPPORT_ALERT_EMAILS, or to every super_admin user when unset.

const { normalizePhone } = require('../utils/phone');
const { EXISTING_TEMPLATES } = require('./whatsappTemplates');

// One open request per phone: repeat messages update it instead of creating
// noise, and the team is re-alerted at most this often for the same person.
const REALERT_AFTER_MS = 6 * 60 * 60 * 1000;
const KINDS = ['problem', 'callback', 'complaint'];

const enqueueWhatsapp = (...a) => require('./agentMessagingService').enqueueAgentWhatsappSend(...a);
const sendEmail = (...a) => require('./emailService').sendSupportAlertEmail(...a);

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function audienceLabel(audience) {
  return { agent: 'Agent', visitor: 'New contact', buyer: 'Buyer' }[audience] || audience;
}

function kindLabel(kind) {
  return { problem: 'needs help', callback: 'wants a call back', complaint: 'has a complaint' }[kind] || kind;
}

/** Pure: the WhatsApp/email alert text (unit-tested). */
function buildAlertText({ name, phone, audience, kind, summary, lastMessage, businessName }) {
  const who = [name, businessName && `(${businessName})`].filter(Boolean).join(' ') || 'Someone';
  return [
    `🆘 *Plotraa support*: ${audienceLabel(audience)} ${kindLabel(kind)}`,
    `👤 ${who}`,
    `📞 ${phone}  ·  wa.me/${String(phone).replace(/\D/g, '')}`,
    summary ? `📝 ${clip(summary, 300)}` : null,
    lastMessage ? `💬 "${clip(lastMessage, 300)}"` : null,
    'Open Admin → Support to mark it contacted.',
  ].filter(Boolean).join('\n');
}

function alertPhones() {
  return String(process.env.SUPPORT_ALERT_PHONES || '')
    .split(',').map((p) => normalizePhone(p.trim())).filter(Boolean);
}

async function alertEmails(knex) {
  const configured = String(process.env.SUPPORT_ALERT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  if (configured.length) return configured;
  const admins = await knex('users').where({ role: 'super_admin' }).whereNotNull('email').select('email');
  return admins.map((a) => a.email);
}

/** Pure: the 3 body variables of the support-alert template ({{1}} who, {{2}} phone, {{3}} what). */
function supportAlertParams(request, businessName) {
  return [
    clip(`${audienceLabel(request.audience)} ${request.name || ''}${businessName ? ` (${businessName})` : ''}`, 60),
    request.phone,
    clip(request.summary || request.last_message || kindLabel(request.kind), 200),
  ];
}

async function sendAlerts(knex, request, { businessName } = {}) {
  const text = buildAlertText({ ...request, lastMessage: request.last_message, businessName });
  const results = { whatsapp: 0, email: 0 };

  const templateName = process.env.SUPPORT_ALERT_TEMPLATE_NAME;
  if (!alertPhones().length) {
    console.warn('[support] SUPPORT_ALERT_PHONES is empty: no WhatsApp alert sent (email only).');
  } else if (!templateName) {
    // Free text only reaches a number that messaged us in the last 24h, so
    // without an approved template the team can silently miss an alert.
    console.warn('[support] SUPPORT_ALERT_TEMPLATE_NAME is not set: WhatsApp alerts are free text and may not be delivered. Create the Meta template (see HANDOVER_2026-10-18_SESSION.md section 4).');
  }
  for (const phone of alertPhones()) {
    try {
      await enqueueWhatsapp({
        tenantId: null,
        phone,
        messageBody: text,
        ...(templateName ? {
          template: {
            name: templateName,
            lang: process.env.SUPPORT_ALERT_TEMPLATE_LANG || 'en',
            bodyParams: supportAlertParams(request, businessName),
            expectedParams: EXISTING_TEMPLATES.support_alert.bodyParams,
          },
        } : {}),
      });
      results.whatsapp += 1;
    } catch (err) {
      console.error('[support] WhatsApp alert failed:', err.message);
    }
  }

  try {
    const emails = await alertEmails(knex);
    for (const to of emails) {
      const r = await sendEmail({ to, subject: `Plotraa support: ${audienceLabel(request.audience)} ${kindLabel(request.kind)} (${request.phone})`, text });
      if (r?.sent) results.email += 1;
    }
  } catch (err) {
    console.error('[support] email alert failed:', err.message);
  }
  return results;
}

/**
 * Opens a support request (or bumps the open one for this phone) and alerts
 * the team. Never throws; returns { request, isNew, alerted } or null.
 */
async function raiseSupportRequest(knex, { phone, name, audience, kind = 'problem', summary, lastMessage, tenantId = null, userId = null }) {
  try {
    const normalized = normalizePhone(phone) || phone;
    const safeKind = KINDS.includes(kind) ? kind : 'problem';
    const open = await knex('support_requests')
      .where({ phone: normalized })
      .whereIn('status', ['open', 'contacted'])
      .orderBy('created_at', 'desc')
      .first();

    let request;
    let isNew = false;
    if (open) {
      [request] = await knex('support_requests').where({ id: open.id }).update({
        last_message: clip(lastMessage, 2000) || open.last_message,
        summary: clip(summary, 1000) || open.summary,
        // A complaint outranks a call-back request, which outranks a question.
        kind: KINDS.indexOf(safeKind) > KINDS.indexOf(open.kind) ? safeKind : open.kind,
        // Someone writing again after being contacted needs attention again.
        status: 'open',
        message_count: knex.raw('message_count + 1'),
        updated_at: knex.fn.now(),
      }).returning('*');
    } else {
      [request] = await knex('support_requests').insert({
        phone: normalized,
        name: clip(name, 255) || null,
        audience,
        kind: safeKind,
        tenant_id: tenantId,
        user_id: userId,
        summary: clip(summary, 1000) || null,
        last_message: clip(lastMessage, 2000) || null,
      }).returning('*');
      isNew = true;
    }

    const lastAlert = request.alerted_at ? new Date(request.alerted_at).getTime() : 0;
    let alerted = false;
    if (isNew || Date.now() - lastAlert > REALERT_AFTER_MS) {
      const tenant = request.tenant_id ? await knex('tenants').where({ id: request.tenant_id }).first('business_name') : null;
      await sendAlerts(knex, request, { businessName: tenant?.business_name });
      await knex('support_requests').where({ id: request.id }).update({ alerted_at: knex.fn.now() });
      alerted = true;
    }
    console.log('[support] %s request %s for %s (%s, %s) alerted=%s', isNew ? 'new' : 'updated', request.id, normalized, audience, request.kind, alerted);
    return { request, isNew, alerted };
  } catch (err) {
    console.error('[support] could not raise support request:', err.message);
    return null;
  }
}

module.exports = { raiseSupportRequest, buildAlertText, supportAlertParams, KINDS };
