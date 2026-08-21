// Shared GPT-4o-mini listing-field extraction — pulled out of
// agentIntakeWorker.js so the WhatsApp agent-intake flow and the web chat
// endpoint (webChatController.js) call the exact same extraction logic
// instead of two copies drifting apart.
const axios = require('axios');

const REQUIRED_FIELDS = ['title', 'raw_address', 'price', 'property_type'];
const FIELD_QUESTIONS = {
  raw_address: "Location/address kya hai? (e.g. 'sector 45 mohali')",
  price: 'Price kitni hai? (e.g. 55 lakh)',
  property_type: 'Property type kya hai — Plot, Villa, ya Commercial?',
  title: 'Ek chhota sa title de dijiye is listing ke liye.',
};

/**
 * GPT-4o-mini extraction. Strict JSON, low temperature (structured
 * extraction, not conversation — vocallmWorker.js uses 0.3 for its
 * conversational replies, this uses 0.15). Instructed to never invent a
 * field the sender didn't actually state — the one exception is `title`,
 * which it may synthesize from property_type + area/address when not
 * given explicitly, so a listing isn't blocked on a follow-up question
 * for something GPT can reasonably infer.
 */
async function extractListingFields(accumulatedText) {
  const systemPrompt = `You extract real-estate listing fields from a Punjab/India property agent's freeform message (often Hinglish/Punjabi-English mixed, using local shorthand).

Return ONLY a JSON object with exactly these keys: title, raw_address, price, plot_area, property_type, description, pincode.

Rules:
- Use null for any field not actually stated in the text — never guess or invent a value, EXCEPT title (see below).
- price: convert Indian shorthand to a plain number in rupees. "55 lakh" -> 5500000, "1.2 crore" -> 12000000, "80k" -> 80000.
- plot_area: keep as the agent's own phrasing (e.g. "250 gaj", "5 marla", "1200 sq ft") — don't convert units.
- property_type: normalize to one of "Plot", "Villa", or "Commercial" if the text implies one of those (e.g. "3BHK", "house", "makan" -> Villa; "shop", "dukaan" -> Commercial); otherwise null.
- title: if the agent gave an explicit title, use it verbatim. If not, synthesize a short one from property_type + area/locality (e.g. "Plot in Sector 45 Mohali") — but only if you have enough to make a real one; otherwise null.
- description: any other descriptive detail mentioned (amenities, condition, etc.) — null if nothing beyond the core fields.
- pincode: a 6-digit Indian postal code, ONLY if one is literally present in the text (e.g. "141001", "160055") — never infer or guess one from a locality name, even if you think you know the area's usual pincode. null if none is stated.

Examples:
Input: "3BHK plot 250 gaj sector 45 mohali 55 lakh"
Output: {"title":"3BHK Plot in Sector 45 Mohali","raw_address":"Sector 45, Mohali","price":5500000,"plot_area":"250 gaj","property_type":"Plot","description":"3BHK","pincode":null}

Input: "shop for sale ludhiana 80 lakh, pincode 141001"
Output: {"title":"Shop in Ludhiana","raw_address":"Ludhiana","price":8000000,"plot_area":null,"property_type":"Commercial","description":null,"pincode":"141001"}`;

  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: accumulatedText },
    ],
    temperature: 0.15,
  }, {
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    timeout: 15000, // fail fast rather than hang the request/worker indefinitely on an OpenAI stall
  });

  return JSON.parse(response.data.choices[0].message.content);
}

module.exports = { extractListingFields, REQUIRED_FIELDS, FIELD_QUESTIONS };
