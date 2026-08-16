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

const whatsappWorker = new Worker('whatsapp-outbound', async (job) => {
  const { tenantId, threadId, leadId, phone, leadName, propertyTitle, messageBody } = job.data;

  console.log(`[Job ${job.id}] Dispatched delivery pipeline loop for Thread: ${threadId} -> Mobile: ${phone}`);

  // Safeguard configuration sanity check before attempting delivery outward
  if (!BSP_GATEWAY_URL || !BSP_API_KEY) {
    throw new Error('Outbound delivery blocked: Missing operational BSP environment configurations.');
  }

  try {
    // 1. Dispatch payload framework to the configured WhatsApp gateway broker interface
    // TODO: Customize this exact payload payload mapping structure once your final BSP platform vendor 
    // (e.g., Meta Cloud API directly, Chat Mitra, Getgabs, or Twilio) has been selected.
    const bspPayload = {
      apiKey: BSP_API_KEY,
      to: phone,
      type: 'text',
      text: {
        body: messageBody
      },
      metadata: {
        tenant_id: tenantId,
        client_name: leadName,
        context: propertyTitle
      }
    };

    const bspResponse = await axios.post(BSP_GATEWAY_URL, bspPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BSP_API_KEY}` // standard header format authorization safeguard
      },
      timeout: 10000 // 10-second request dropout boundary rule to catch gateway hangs
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
        sent_at: knex.fn.now()
      });
    }

    console.log(`[Job ${job.id}] Outbound transaction securely committed to data records.`);
    return { success: true };

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
whatsappWorker.on('failed', (job, err) => {
  console.error(`🚨 [Job ${job?.id}] Outbound automated WhatsApp message has completely exhausted its retry limit:`, err.message);
});

module.exports = whatsappWorker;