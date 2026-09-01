// Shared GPT-4o-mini listing-field extraction — pulled out of
// agentIntakeWorker.js so the WhatsApp agent-intake flow and the web chat
// endpoint (webChatController.js) call the exact same extraction logic
// instead of two copies drifting apart.
const axios = require('axios');

const REQUIRED_FIELDS = ['title', 'raw_address', 'property_type'];
const FIELD_QUESTIONS = {
  raw_address: "Property ka address kya hai? (e.g. 'Plot No. 142-B, Ranjit Avenue, Amritsar' ya 'SCO 145, Sector 34-A, Chandigarh')",
  price: 'Price kitni hai? (e.g. 55 lakh)',
  property_type: 'Property type kya hai — Plot, Flat, Villa, Commercial?',
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
 *
 * @param {string} accumulatedText
 * @param {{raw_address?: string, building_name?: string, price?: number, property_type?: string}} [correctionContext]
 *   Pass the LISTING'S CURRENT values when this text is a correction reply
 *   to a listing already sitting in awaiting_approval (see
 *   agentIntakeController.js). Without this, a short correction like
 *   "wrong information i typed ludhiana" has no way to be understood as
 *   "replace raw_address with Ludhiana" — GPT sees it as an unrelated
 *   fragment and (correctly, given only that context) extracts nothing,
 *   which is what caused the identical-reminder loop dealers hit.
 */
async function extractListingFields(accumulatedText, correctionContext) {
  const correctionSection = correctionContext
    ? `\n\nCORRECTION MODE: the message below is a correction/reply to a listing that is already sitting with these current values: ${JSON.stringify(correctionContext)}. The person is telling you what's wrong or giving a replacement value — they are NOT describing a brand-new property from scratch, so don't expect a full sentence. Read the message as "replace field X with this" even if it's just a bare word or two (e.g. a lone city name means "replace raw_address with this city"). Only extract the field(s) actually being corrected; everything else stays null (unchanged). If the message is pure commentary with no replacement value at all (e.g. "it's wrong", "how do I fix this"), return every field null exactly as the normal rules say.`
    : '';

  const systemPrompt = `You extract real-estate listing fields from a Punjab/India property agent's freeform message (often Hinglish/Punjabi-English mixed, using local shorthand).${correctionSection}

Return ONLY a JSON object with exactly these keys: title, raw_address, price, plot_area, property_type, description, pincode, building_name.

Rules:
- Use null for any field not actually stated in the text — never guess or invent a value, EXCEPT title (see below).
- price: convert Indian shorthand to a plain number in rupees. "55 lakh" -> 5500000, "1.2 crore" -> 12000000, "80k" -> 80000.
- plot_area: keep as the agent's own phrasing (e.g. "250 gaj", "5 marla", "1200 sq ft") — don't convert units.
- property_type: normalize to one of "Plot", "Flat", "Villa", or "Commercial". An EXPLICIT type word in the text always wins, even if another word would otherwise suggest a different type — e.g. "3BHK plot" is a Plot (the word "plot" is stated directly), not a Villa, even though "3BHK" alone would normally suggest Villa. Only fall back to inferring from an implicit signal when no explicit type word is present: "3BHK"/"house"/"makan"/"kothi" -> Villa, UNLESS a specific building/tower/mall name is also given (see building_name below), in which case a bare BHK mention -> Flat, since a unit inside a named building is an apartment, not a standalone house. "shop"/"dukaan"/"retail space"/"showroom"/"office"/"school"/"hospital"/"clinic"/"dispensary"/"college"/"institute"/"university"/"coaching"/"academy"/"hotel"/"restaurant"/"factory"/"warehouse"/"godown"/"industrial"/"shed"/"mall"/"market" -> Commercial. "land"/"khet"/"agricultural land"/"farmhouse"/"farm"/"agricultural" -> Plot (only when no more specific type is stated). Use null if genuinely neither is present.
- building_name: the specific building, tower, society, or mall name the property is IN or PART OF, if one is named — e.g. "DLF Chandigarh One", "Omaxe Celebration Mall", "Elante Mall", "ABC Heights Tower 3". This is distinct from a general locality/address (e.g. "Sector 45 Mohali" is NOT a building_name — that's raw_address). A message that names ONLY a building/mall with no separate street address ("flat available in DLF Chandigarh One", "retail space in Elante Mall") still counts — extract the name here even though raw_address may end up null from the text alone. null if no specific named building/project/mall is mentioned.
- raw_address: the address/locality as stated. CRITICAL — building_name and raw_address are NOT mutually exclusive. Many messages name a building/society AND its city/locality in the same breath (e.g. "Hero Homes South City Ludhiana", "flat in DLF Chandigarh One Zirakpur"). Whenever a city/locality/area name appears ANYWHERE in the message alongside a building_name, you MUST put that city/locality in raw_address — do not leave raw_address null just because a building_name is also present. A city name is critical for finding the correct location on a map and must never be dropped. Only leave raw_address null when the message names ONLY a building/mall/society with truly no city, locality, or area mentioned anywhere in the text — it then gets filled in from building_name automatically after extraction, do not duplicate it yourself in that specific case.
- title: if the agent gave an explicit title, use it verbatim. If not, synthesize a short one from property_type + building_name (if present) or area/locality (e.g. "Flat in DLF Chandigarh One", "Retail Space in Elante Mall", "Plot in Sector 45 Mohali") — but only if you have enough to make a real one; otherwise null.
- description: any other descriptive detail mentioned (amenities, condition, etc.) — null if nothing beyond the core fields.
- pincode: a 6-digit Indian postal code, ONLY if one is literally present in the text (e.g. "141001", "160055") — never infer or guess one from a locality name, even if you think you know the area's usual pincode. null if none is stated.

Examples:
Input: "3BHK plot 250 gaj sector 45 mohali 55 lakh"
Output: {"title":"3BHK Plot in Sector 45 Mohali","raw_address":"Sector 45, Mohali","price":5500000,"plot_area":"250 gaj","property_type":"Plot","description":"3BHK","pincode":null,"building_name":null}

Input: "shop for sale ludhiana 80 lakh, pincode 141001"
Output: {"title":"Shop in Ludhiana","raw_address":"Ludhiana","price":8000000,"plot_area":null,"property_type":"Commercial","description":null,"pincode":"141001","building_name":null}

Input: "3BHK plot in Sector 45 Mohali"
Output: {"title":"3BHK Plot in Sector 45 Mohali","raw_address":"Sector 45, Mohali","price":null,"plot_area":null,"property_type":"Plot","description":"3BHK","pincode":null,"building_name":null}

Input: "flat available in DLF Chandigarh One"
Output: {"title":"Flat in DLF Chandigarh One","raw_address":null,"price":null,"plot_area":null,"property_type":"Flat","description":null,"pincode":null,"building_name":"DLF Chandigarh One"}

Input: "retail space available in Elante Mall, 60 lakh"
Output: {"title":"Retail Space in Elante Mall","raw_address":null,"price":6000000,"plot_area":null,"property_type":"Commercial","description":null,"pincode":null,"building_name":"Elante Mall"}

Input: "flat in Hero Homes South City Ludhiana, 45 lakh"
Output: {"title":"Flat in Hero Homes South City","raw_address":"Ludhiana","price":4500000,"plot_area":null,"property_type":"Flat","description":null,"pincode":null,"building_name":"Hero Homes South City"}`;

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

  const parsed = JSON.parse(response.data.choices[0].message.content);

  // A message naming ONLY a building/mall ("flat available in DLF Chandigarh
  // One") with truly no city/locality anywhere has nothing else geocodable —
  // fall back to the building name itself as the address text. Google's
  // geocoder resolves a well-known building/mall name on its own fine; this
  // just keeps "only a building name" from getting stuck on the raw_address
  // required-field check. With the CRITICAL rule above, this should now only
  // fire for genuinely building-only messages — a message that also named a
  // city (e.g. "Hero Homes South City Ludhiana") should already have that
  // city in raw_address from the model itself, not hit this fallback at all.
  if (!parsed.raw_address && parsed.building_name) {
    parsed.raw_address = parsed.building_name;
  }

  return parsed;
}

module.exports = { extractListingFields, REQUIRED_FIELDS, FIELD_QUESTIONS };
