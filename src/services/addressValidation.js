const axios = require('axios');

/**
 * Calls Google's Address Validation API (POST validateAddress).
 * Returns the full response body: { result: { verdict, address, geocode, metadata }, responseId }
 *
 * The fields we care about:
 *   result.geocode.location.{latitude,longitude} — coordinates (replaces Geocoding API)
 *   result.address.formattedAddress             — standardized address string
 *   result.verdict.addressComplete              — true when all components resolved
 *   result.address.addressComponents[*].confirmationLevel — per-component confidence
 *   responseId                                  — opaque token for provideValidationFeedback
 */
async function validateAddress({ addressLines, apiKey }) {
  const resp = await axios.post(
    `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`,
    { address: { regionCode: 'IN', addressLines } },
    { timeout: 8000 }
  );
  return resp.data; // { result, responseId }
}

/**
 * Sends outcome feedback to Google after a pin is confirmed or manually corrected.
 * conclusion: 'VALIDATED_VERSION_USED' (agent approved as-is)
 *           | 'USER_VERSION_USED'      (dealer dragged pin / corrected address)
 *
 * Non-throwing — a feedback failure must never break the listing approval flow.
 * Google uses these signals to improve their model; calls are not billed the same
 * as validation calls (confirm in Cloud Console before relying on that).
 */
async function provideValidationFeedback({ responseId, conclusion, apiKey }) {
  try {
    await axios.post(
      `https://addressvalidation.googleapis.com/v1:provideValidationFeedback?key=${apiKey}`,
      { conclusion, responseId },
      { timeout: 8000 }
    );
  } catch (err) {
    console.error('provideValidationFeedback failed (non-fatal):', err.message);
  }
}

module.exports = { validateAddress, provideValidationFeedback };
