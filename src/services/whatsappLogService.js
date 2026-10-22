// src/services/whatsappLogService.js
//
// Two small pieces of WhatsApp bookkeeping:
//
// 1. Contact windows. Meta only accepts free text to a number that messaged
//    us in the last 24 hours. We record the last inbound message per phone so
//    the outbound worker knows whether to send free text or a template.
// 2. Template send log. Every template send is recorded with the message id
//    Meta returned and, if it failed, the error. Meta's delivery receipts
//    (statuses in the inbound webhook) update the same row, so "the template
//    was sent but never delivered" is visible in Admin.

const WINDOW_MS = 24 * 60 * 60 * 1000;

function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Stored phones are E.164 with '+'; Meta's wa_id has none. Normalize to '+digits'. */
function storedPhone(phone) {
  const d = digits(phone);
  return d ? `+${d}` : null;
}

async function touchContactWindow(knex, phone, now = new Date()) {
  const p = storedPhone(phone);
  if (!p) return;
  await knex.raw(
    `INSERT INTO whatsapp_contact_windows (phone, last_inbound_at) VALUES (?, ?)
     ON CONFLICT (phone) DO UPDATE SET last_inbound_at = EXCLUDED.last_inbound_at`,
    [p, now],
  );
}

/** Pure: is the 24h window open given the last inbound time (or null)? */
function windowOpenAt(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) return false;
  return now.getTime() - new Date(lastInboundAt).getTime() < WINDOW_MS - 60 * 1000;
}

async function isWindowOpen(knex, phone, now = new Date()) {
  const p = storedPhone(phone);
  if (!p) return false;
  const row = await knex('whatsapp_contact_windows').where({ phone: p }).first('last_inbound_at');
  return windowOpenAt(row?.last_inbound_at, now);
}

/** Pure: Meta's message id from a send response (Cloud API shape, with fallbacks for other BSPs). */
function extractMessageId(data) {
  if (!data) return null;
  return data.messages?.[0]?.id || data.message_id || data.messageId || data.id || null;
}

async function logTemplateAttempt(knex, { jobId, template, phone, tenantId, attempts }) {
  const row = {
    job_id: jobId ? String(jobId) : null,
    template_name: template.name,
    lang: template.lang || null,
    phone: storedPhone(phone) || String(phone),
    tenant_id: tenantId || null,
    param_count: template.bodyParams?.length || 0,
    body_params: JSON.stringify(template.bodyParams || []),
    status: 'queued',
    attempts: attempts || 1,
    updated_at: knex.fn.now(),
  };
  if (!row.job_id) {
    await knex('whatsapp_template_sends').insert(row);
    return;
  }
  await knex('whatsapp_template_sends').insert(row)
    .onConflict('job_id').merge({ attempts: row.attempts, status: 'queued', updated_at: knex.fn.now() });
}

async function markTemplateSent(knex, { jobId, metaMessageId }) {
  if (!jobId) return;
  await knex('whatsapp_template_sends').where({ job_id: String(jobId) })
    .update({ status: 'sent', meta_message_id: metaMessageId || null, error: null, updated_at: knex.fn.now() });
}

async function markTemplateFailed(knex, { jobId, error }) {
  if (!jobId) return;
  await knex('whatsapp_template_sends').where({ job_id: String(jobId) })
    .update({ status: 'failed', error: String(error || '').slice(0, 4000), updated_at: knex.fn.now() });
}

const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/** Pure: error text from a Meta status entry. */
function statusError(status) {
  const e = status?.errors?.[0];
  if (!e) return null;
  return [e.code && `#${e.code}`, e.title, e.message, e.error_data?.details].filter(Boolean).join(' - ').slice(0, 4000);
}

/**
 * Applies Meta delivery receipts (value.statuses[]) to the template log.
 * Only moves a row forward (sent -> delivered -> read) or to failed.
 * Returns the number of rows touched.
 */
async function applyDeliveryStatuses(knex, statuses) {
  let touched = 0;
  for (const s of statuses || []) {
    if (!s?.id || !STATUS_RANK.hasOwnProperty(s.status)) continue;
    const row = await knex('whatsapp_template_sends').where({ meta_message_id: s.id }).first('id', 'status');
    if (!row) continue;
    if (s.status !== 'failed' && STATUS_RANK[s.status] <= STATUS_RANK[row.status]) continue;
    await knex('whatsapp_template_sends').where({ id: row.id }).update({
      status: s.status,
      error: s.status === 'failed' ? (statusError(s) || 'Delivery failed (no error detail from Meta)') : null,
      updated_at: knex.fn.now(),
    });
    touched += 1;
  }
  return touched;
}

module.exports = {
  WINDOW_MS,
  storedPhone,
  touchContactWindow,
  windowOpenAt,
  isWindowOpen,
  extractMessageId,
  logTemplateAttempt,
  markTemplateSent,
  markTemplateFailed,
  statusError,
  applyDeliveryStatuses,
};
