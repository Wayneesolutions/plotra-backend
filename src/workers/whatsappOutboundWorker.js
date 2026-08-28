// src/workers/whatsappOutboundWorker.js
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const axios = require('axios');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);

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
  const { tenantId, threadId, leadId, phone, leadName, propertyTitle, messageBody } = job.data;

  console.log(`[Job ${job.id}] Dispatched delivery pipeline loop for Thread: ${threadId} -> Mobile: ${phone}`);

  // Safeguard configuration sanity check before attempting delivery outward
  if (!BSP_GATEWAY_URL || !BSP_API_KEY) {
    throw new Error('Outbound delivery blocked: Missing operational BSP environment configurations.');
  }

  const { withinWindow } = await checkServiceWindow(threadId);

  let bspPayload;
  let deliveryStatus = 'sent';

  if (withinWindow) {
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

  try {
    const bspResponse = await axios.post(BSP_GATEWAY_URL, bspPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BSP_API_KEY}`,
      },
      timeout: 10000,
    });

    console.log(`[Job ${job.id}] BSP Gateway acknowledged acceptance:`, bspResponse.data);

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
    
    // Bubble error outward to trigger configured automatic BullMQ retry backoff policies
    throw error;
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