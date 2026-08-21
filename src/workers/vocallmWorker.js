// src/workers/vocallmWorker.js
const { Worker, Queue } = require('bullmq');
const IORedis = require('ioredis');
const axios = require('axios');
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redisConnection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null }); // required by BullMQ Worker (blocking commands) — omitting this throws on boot

// Initialize the outbound queue to dispatch the completed reply back to the user
const whatsappOutboundQueue = new Queue('whatsapp-outbound', { connection: redisConnection });

console.log(`[Worker Engine] Initializing VoCallM AI Chat Processor...`);

const vocallmWorker = new Worker('vocallm-chat-processor', async (job) => {
  const { tenantId, threadId, leadId, listingId, incomingText, phone } = job.data;
  
  console.log(`[Job ${job.id}] VoCallM processing message for Thread: ${threadId}`);

  try {
    // 1. Gather all required context: Listing Details & Surrounding Mapped Landmarks
    const listing = await knex('listings').where({ id: listingId }).first();
    if (!listing) throw new Error(`Listing context ${listingId} missing.`);

    const landmarks = await knex('listing_landmarks')
      .where({ listing_id: listingId })
      .orderBy('distance_meters', 'asc');

    const lead = await knex('leads').where({ id: leadId }).first();
    const leadName = lead?.name || 'Customer';

    // 2. Format a structured landmark list for the AI prompt
    const landmarkSummary = landmarks.map(l => 
      `- ${l.place_name} (${l.place_type}): ${l.distance_meters} meters away, approx. ${l.walk_minutes} mins walk / ${l.drive_minutes} mins drive.`
    ).join('\n');

    // 3. Construct the System Prompt enforcing business logic constraints
    const systemPrompt = `You are an elite real estate assistant powered by VoCallM for our real estate firm.
Your job is to answer buyer queries about specific plots professionally, accurately, and politely.

PROPERTY DETAILS:
- Title: ${listing.title}
- Property Type: ${listing.property_type}
- Price: ${listing.price != null ? 'INR ' + parseFloat(listing.price).toLocaleString('en-IN') : 'Not disclosed publicly — if asked, say pricing is available on request and offer to have an agent follow up.'}
- Area: ${listing.plot_area}
- Location Description: ${listing.description}

NEARBY INFRASTRUCTURE & LANDMARKS:
${landmarkSummary || 'No landmarks indexed nearby yet.'}

CONSTRAINTS:
1. Be polite, clear, and direct. Use professional real estate language suitable for the Indian/Punjab property market.
2. Rely ONLY on the provided property details and landmarks. If asked about a landmark or feature not listed, politely state that you don't have that specific data on hand and offer to have an agent check.
3. Keep the tone helpful, encouraging a viewing or deep interaction.
4. Keep the answer under 150 words so it fits beautifully in a single WhatsApp message message frame.`;

    // 4. Send the payload to your LLM API (e.g., OpenAI GPT-4o or similar configured pipeline)
    // In production, ensure OPENAI_API_KEY is securely configured in your env file
    const openAiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Buyer (${leadName}): "${incomingText}"` }
      ],
      temperature: 0.3 // Low temperature keeps the answers highly factual and data-bound
    }, {
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    const aiReply = openAiResponse.data.choices[0].message.content.trim();

    // 5. Hand the generated message directly to the outbound queue for delivery
    await whatsappOutboundQueue.add('send-automated-reply', {
      tenantId,
      threadId,
      leadId,
      phone,
      leadName,
      propertyTitle: listing.title,
      messageBody: aiReply
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });

    console.log(`[Job ${job.id}] VoCallM reply processed successfully and queued for dispatch.`);
    return { success: true, replyLength: aiReply.length };

  } catch (error) {
    console.error(`[Job ${job.id}] VoCallM runtime processing failure:`, error.message);
    throw error;
  }
}, { connection: redisConnection });

module.exports = vocallmWorker;