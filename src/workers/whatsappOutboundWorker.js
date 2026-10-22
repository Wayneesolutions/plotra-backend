// src/workers/whatsappOutboundWorker.js
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const axios = require('axios');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const {
  isWindowOpen, extractMessageId, logTemplateAttempt, markTemplateSent, markTemplateFailed,
} = require('../services/whatsappLogService');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const BSP_GATEWAY_URL = process.env.BSP_GATEWAY_URL;
const BSP_API_KEY = process.env.BSP_API_KEY;

// Establish dedicated connection to the Redis event cluster broker
const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

console.log(`[Worker Engine] Initializing WhatsApp Outbound Delivery Agent...`);

const DEFAULT_REENGAGEMENT_TEMPLATE_NAME = process.env.WHATSAPP_REENGAGEMENT_TEMPLATE_NAME || null;
const DEFAULT_REENGAGEMENT_TEMPLATE_LANG = process.env.WHATSAPP_REENGAGEMENT_TEMPLATE_LANG || 'en';

/**
 * WhatsApp Business Platform rule: outside the 24h customer-service window
 * (whatsapp_threads.service_window_expires_at), Meta rejects a free-form
 * `type: 'text'` send outright — only a pre-approved template message is
 * allowed. Nothing in this worker checked that before this fix, so any
 * reply attempted after the window closed silently failed (3 retries, none
 * of which help — the window doesn't reopen on its own — then a permanent
 * failure logged only to the console, invisible to anyone). Only buyer
 * sends (threadId present) have a window to check at all — agent-intake
 * sends (agentIntakeController.js/agentIntakeWorker.js) have no thread and
 * are unaffected, same as the existing threadId-guard below.
 */
async function checkServiceWindow(threadId) {
  if (!threadId) return { withinWindow: true }; // no thread = agent-intake send, not subject to this check

  const thread = await knex('whatsapp_threads').where({ id: threadId }).first();
  if (!thread) return { withinWindow: true }; // shouldn't happen, but don't block a send over a lookup miss

  const withinWindow = !thread.service_window_expires_at || new Date(thread.service_window_expires_at) > new Date();
  return { withinWindow, tenantId: thread.tenant_id };
}

const whatsappWorker = new Worker('whatsapp-outbound', async (job) => {
  const { tenantId, threadId, leadId, phone, leadName, propertyTitle, messageBody, buttons, template } = job.data;

  console.log(`[Job ${job.id}] Dispatched delivery pipeline loop for Thread: ${threadId} -> Mobile: ${phone}`);

  // Safeguard configuration sanity check before attempting delivery outward
  if (!BSP_GATEWAY_URL || !BSP_API_KEY) {
    throw new Error('Outbound delivery blocked: Missing operational BSP environment configurations.');
  }

  const { withinWindow } = await checkServiceWindow(threadId);

  let bspPayload;
  let deliveryStatus = 'sent';

  // templateMode 'auto' (dealer welcome, invites, reminders, lead alerts):
  // free text while the person's own 24h window is open, the template
  // otherwise. Any other template send is always the template.
  let useTemplate = Boolean(template?.name);
  let freeTextFallback = null;
  if (useTemplate && template.templateMode === 'auto' && messageBody) {
    if (await isWindowOpen(knex, phone)) {
      useTemplate = false;
    } else {
      freeTextFallback = { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { body: messageBody } };
    }
  }
  if (useTemplate && Number.isInteger(template.expectedParams)
      && (template.bodyParams?.length || 0) !== template.expectedParams) {
    // Meta rejects a template with the wrong number of variables. Retrying
    // cannot help, so fail loudly once instead of burning 3 attempts.
    const msg = `Template "${template.name}" expects ${template.expectedParams} variables but got ${template.bodyParams?.length || 0}.`;
    console.error(`[Job ${job.id}] ${msg}`);
    await logTemplateAttempt(knex, { jobId: job.id, template, phone, tenantId, attempts: job.attemptsMade + 1 }).catch(() => {});
    await markTemplateFailed(knex, { jobId: job.id, error: msg }).catch(() => {});
    return { success: false, skipped: 'template_param_mismatch' };
  }

  if (useTemplate) {
    // Explicit template send — the caller already knows no service window
    // can be open (e.g. callEnquiryService.js: the buyer phoned, they never
    // messaged), so there is nothing to check; a template is the only thing
    // Meta will accept as the first message. bodyParams fill {{1}}, {{2}}…
    // in order. quickReplyPayload, when set, is attached to the template's
    // first quick-reply button and comes back on the inbound webhook when
    // the buyer taps it (messages[0].button.payload).
    const components = [];
    if (template.bodyParams?.length) {
      components.push({
        type: 'body',
        parameters: template.bodyParams.map((text) => ({ type: 'text', text: String(text) })),
      });
    }
    if (template.quickReplyPayload) {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: template.quickReplyPayload }],
      });
    }
    bspPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.lang || 'en' },
        components,
      },
    };
    deliveryStatus = 'template_sent';
  } else if (withinWindow && buttons?.length) {
    // Meta Cloud API interactive-button message — up to 3 quick-reply
    // buttons (Meta's own limit), each { id, title } (title capped at 20
    // chars by Meta; not validated here since every caller so far
    // controls its own button text directly — see
    // listingStatusCheckService.js for the first one). Same 24h-window
    // rule as a plain text send; outside the window this falls through to
    // the template path below like any other send (a template message
    // can't carry ad-hoc buttons, so the reply-options text is baked into
    // messageBody's template variable instead in that case).
    bspPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: messageBody },
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
        },
      },
    };
  } else if (withinWindow) {
    // Meta Cloud API format: https://graph.facebook.com/v25.0/{phone_number_id}/messages
    bspPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: messageBody },
    };
  } else {
    // Window closed — resolve a template (per-tenant override first, then
    // the platform-wide env-var default). No free-form fallback: sending
    // `type: 'text'` here would just get rejected by Meta again.
    const config = tenantId ? await knex('tenant_configs').where({ tenant_id: tenantId }).first() : null;
    const templateName = config?.whatsapp_reengagement_template_name || DEFAULT_REENGAGEMENT_TEMPLATE_NAME;
    const templateLang = config?.whatsapp_reengagement_template_lang || DEFAULT_REENGAGEMENT_TEMPLATE_LANG;

    if (!templateName) {
      // No template configured anywhere — sending will fail either way, and
      // retrying won't fix it (the window stays closed). Log it visibly
      // instead of silently burning 3 retries on a guaranteed-reject send.
      console.error(`[Job ${job.id}] Skipping send: 24h service window closed for thread ${threadId} and no re-engagement template is configured (set WHATSAPP_REENGAGEMENT_TEMPLATE_NAME or tenant_configs.whatsapp_reengagement_template_name).`);

      if (threadId) {
        await knex('whatsapp_messages').insert({
          id: knex.raw('uuid_generate_v4()'),
          thread_id: threadId,
          direction: 'outbound',
          sender_type: 'vocallm',
          message_category: 'utility',
          body: messageBody.trim(),
          sent_at: knex.fn.now(),
          delivery_status: 'failed',
          delivery_failure_reason: '24h service window closed; no re-engagement template configured',
        });
      }

      // Return success (not throw) — this is a config gap, not a transient
      // error, so BullMQ retrying the same job 3x accomplishes nothing.
      return { success: false, skipped: 'window_closed_no_template' };
    }

    bspPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLang },
        // Re-engagement templates in this platform are expected to take a
        // single body variable (property/lead context) — adjust here if a
        // tenant's approved template shape differs.
        components: [{ type: 'body', parameters: [{ type: 'text', text: propertyTitle || leadName || 'your enquiry' }] }],
      },
    };
    deliveryStatus = 'template_sent';
  }

  const isTemplateSend = bspPayload.type === 'template';
  const loggedTemplate = isTemplateSend
    ? (template?.name ? template : { name: bspPayload.template.name, lang: bspPayload.template.language?.code, bodyParams: (bspPayload.template.components?.[0]?.parameters || []).map((p) => p.text) })
    : null;
  if (loggedTemplate) {
    await logTemplateAttempt(knex, { jobId: job.id, template: loggedTemplate, phone, tenantId, attempts: job.attemptsMade + 1 })
      .catch((logErr) => console.error(`[Job ${job.id}] Could not log template attempt:`, logErr.message));
  }

  const send = (payload) => axios.post(BSP_GATEWAY_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BSP_API_KEY}`,
    },
    timeout: 10000,
  });

  try {
    let bspResponse;
    try {
      bspResponse = await send(bspPayload);
    } catch (templateErr) {
      // An auto-mode template that Meta refused (not created/approved yet,
      // wrong variables): the window may still be open, so try the free text
      // once. If that fails too, the original template error is what's logged.
      if (!freeTextFallback || !isTemplateSend) throw templateErr;
      const templateDetail = templateErr.response ? JSON.stringify(templateErr.response.data) : templateErr.message;
      console.warn(`[Job ${job.id}] Template send failed (${templateDetail}); trying free text.`);
      await markTemplateFailed(knex, { jobId: job.id, error: templateDetail }).catch(() => {});
      try {
        bspResponse = await send(freeTextFallback);
        return { success: true, deliveryStatus: 'sent_as_text_after_template_failure' };
      } catch {
        throw templateErr;
      }
    }

    console.log(`[Job ${job.id}] BSP Gateway acknowledged acceptance:`, bspResponse.data);
    if (isTemplateSend) {
      await markTemplateSent(knex, { jobId: job.id, metaMessageId: extractMessageId(bspResponse.data) })
        .catch((logErr) => console.error(`[Job ${job.id}] Could not log template message id:`, logErr.message));
    }

    // 2. Persist the outbound interaction history — only when this send is
    // tied to a buyer whatsapp_threads row. Agent-intake sends (see
    // agentIntakeController.js/agentIntakeWorker.js) reuse this same queue
    // but have no thread — thread_id is NOT NULL with an FK, so inserting
    // with threadId: null would throw *after* the message was already sent,
    // and since this job has attempts: 3, BullMQ would retry the whole job
    // — including the axios.post above — resending the same WhatsApp
    // message 2-3 times. Those sends are instead logged to
    // agent_draft_messages by the caller.
    if (threadId) {
      await knex('whatsapp_messages').insert({
        id: knex.raw('uuid_generate_v4()'),
        thread_id: threadId,
        direction: 'outbound',
        sender_type: 'vocallm',
        message_category: 'utility',
        body: messageBody.trim(),
        sent_at: knex.fn.now(),
        delivery_status: deliveryStatus,
      });
    }

    console.log(`[Job ${job.id}] Outbound transaction securely committed to data records.`);
    return { success: true, deliveryStatus };

  } catch (error) {
    // Collect error profiles safely to diagnose network drops vs structural API errors
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error(`❌ [Job ${job.id}] Outbound delivery agent dropped connection context:`, errorMessage);

    // Re-throw with the FULL captured body as the message, not the original
    // axios error (whose .message is just a generic "Request failed with
    // status code 400/401" with no indication of the actual rejection
    // reason). err.message is what both BullMQ's own stored failure reason
    // and the on('failed') handler's delivery_failure_reason column below
    // end up persisting — without this, the real WhatsApp API error body
    // was only ever visible in these ephemeral console logs, never in
    // anything queryable after the fact.
    const richError = new Error(errorMessage);
    richError.status = error.response?.status;
    if (isTemplateSend) {
      await markTemplateFailed(knex, { jobId: job.id, error: errorMessage })
        .catch((logErr) => console.error(`[Job ${job.id}] Could not log template error:`, logErr.message));
    }
    throw richError;
  }
}, {
  connection: redisConnection,
  // 3. Configure robust retry properties mirroring core geocoding consumer execution strategies
  settings: {
    backoff: {
      type: 'exponential',
      delay: 2000 // Floor interval value window configuration
    }
  }
});

// Event hook tracking diagnostics across standard infrastructure monitors
whatsappWorker.on('failed', async (job, err) => {
  console.error(`🚨 [Job ${job?.id}] Outbound automated WhatsApp message has completely exhausted its retry limit:`, err.message);

  // Same visibility fix as the window-closed case above — a permanently
  // failed send previously left no trace anywhere a human could see it.
  const threadId = job?.data?.threadId;
  const messageBody = job?.data?.messageBody;
  if (threadId && job.attemptsMade >= job.opts.attempts) {
    try {
      await knex('whatsapp_messages').insert({
        id: knex.raw('uuid_generate_v4()'),
        thread_id: threadId,
        direction: 'outbound',
        sender_type: 'vocallm',
        message_category: 'utility',
        body: (messageBody || '').trim(),
        sent_at: knex.fn.now(),
        delivery_status: 'failed',
        delivery_failure_reason: err.message,
      });
    } catch (logErr) {
      console.error(`[Job ${job?.id}] Failed to log permanent delivery failure:`, logErr.message);
    }
  }
});

module.exports = whatsappWorker;