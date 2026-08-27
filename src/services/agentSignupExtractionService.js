// GPT-4o-mini extraction for the agent self-registration flow — sibling to
// listingExtractionService.js, same model/temperature/strict-JSON pattern,
// but pulling {name, address} out of a prospective agent's freeform "join
// as agent" WhatsApp conversation instead of listing fields. Kept as a
// separate service (not a shared extractor) since the two field sets,
// required-field lists, and follow-up questions are unrelated.
const axios = require('axios');

const REQUIRED_FIELDS = ['name', 'address'];

const FIELD_QUESTIONS = {
  name: 'Aapka poora naam kya hai?',
  address: 'Aap kis area/city mein kaam karte ho?',
};

const FIELD_QUESTIONS_EN = {
  name: "What's your full name?",
  address: 'Which area/city do you operate in?',
};

/**
 * Strict JSON, low temperature (structured extraction, not conversation).
 * Never invents a value — both fields are null unless actually stated.
 */
async function extractAgentSignupFields(accumulatedText) {
  const systemPrompt = `You extract a prospective real-estate agent's name and operating area from their freeform WhatsApp message (often Hinglish/Punjabi-English mixed), sent in response to a "join as agent" self-registration flow.

Return ONLY a JSON object with exactly these keys: name, address.

Rules:
- name: their full name, ONLY if actually stated in the text — never guess or invent one. null if not given.
- address: the area, city, or locality they say they operate/work in, as stated. null if not given.

Examples:
Input: "join as agent, I'm Ramanpreet Kaur, I deal in Sector 45 Mohali"
Output: {"name":"Ramanpreet Kaur","address":"Sector 45, Mohali"}

Input: "join as agent"
Output: {"name":null,"address":null}

Input: "mera naam Rajesh hai, Ludhiana mein kaam karta hoon"
Output: {"name":"Rajesh","address":"Ludhiana"}`;

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
    timeout: 15000,
  });

  return JSON.parse(response.data.choices[0].message.content);
}

module.exports = { extractAgentSignupFields, REQUIRED_FIELDS, FIELD_QUESTIONS, FIELD_QUESTIONS_EN };
