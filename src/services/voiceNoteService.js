// src/services/voiceNoteService.js
//
// WhatsApp voice notes from dealers and buyers. A voice note is downloaded
// from Meta, transcribed by OpenAI, and the transcript is then handled
// exactly like a typed message (webhookController.js swaps it in as
// incomingText). Nothing downstream needs to know it was spoken.
//
// Dealers and buyers in Punjab speak Punjabi, Hindi, Hinglish and English,
// often mixed in one sentence. The prompt below steers the transcript to
// Roman script (Hinglish), which is what every keyword check and the
// language detector in this codebase were built around, and seeds the
// real-estate words (gaj, marla, kanal, kothi, lakh, crore) and Ludhiana
// localities the model would otherwise mishear.

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const FALLBACK_MODEL = 'whisper-1';

// WhatsApp voice notes are opus-in-ogg and tiny (~1MB per minute). Anything
// bigger than this is not a normal voice note; skip it rather than pay for it.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.VOICE_TRANSCRIBE_TIMEOUT_MS) || 25000;

// Keep this a plain vocabulary list. Never put a full example sentence in it:
// on silence or noise the model echoes the prompt back as the "transcript",
// and an example sentence then turns into a fake property listing.
const TRANSCRIBE_PROMPT = [
  'Property dealer aur customer ki WhatsApp voice note. Punjabi, Hindi, Hinglish ya English. Roman script mein likho.',
  'Shabd: gaj, marla, kanal, kothi, makaan, plot, flat, BHK, lakh, crore, registry, NOC, Dugri, Sarabha Nagar, BRS Nagar, Pakhowal Road, Ferozepur Road, Mohali, Kharar, Zirakpur.',
].join(' ');

// Sentences earlier versions of the prompt contained; models still echo them
// on silence, so they stay on the block list even though they were removed.
const LEGACY_PROMPT_ECHOES = [
  'model town ludhiana mein 200 gaj ki kothi hai 1.2 crore 3 bhk corner plot',
];

function normalizeForEcho(text) {
  // Keep the dot only inside numbers ("1.2"); sentence-final dots must not
  // stop "crore." matching "crore registry".
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const NORMALIZED_PROMPT = normalizeForEcho(TRANSCRIBE_PROMPT);

/** True when the "transcript" is just the prompt (or part of it) read back. */
function isPromptEcho(text) {
  const t = normalizeForEcho(text);
  if (t.length < 8) return false;
  if (NORMALIZED_PROMPT.includes(t)) return true;
  return LEGACY_PROMPT_ECHOES.some((e) => t.includes(e) || e.includes(t));
}

function isVoiceEnabled() {
  return String(process.env.VOICE_NOTES || 'on').toLowerCase() !== 'off' && Boolean(process.env.OPENAI_API_KEY);
}

function fileNameFor(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'voice.mp3';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'voice.m4a';
  if (mime.includes('amr')) return 'voice.amr';
  if (mime.includes('wav')) return 'voice.wav';
  if (mime.includes('webm')) return 'voice.webm';
  return 'voice.ogg'; // WhatsApp's default: audio/ogg; codecs=opus
}

/**
 * Trims and sanity-checks a transcript. Returns null for empty output or for
 * the filler a speech model emits on silence ("Thank you.", "...").
 */
function cleanTranscript(text, { durationSec = null } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const letters = t.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length < 2) return null;
  if (/^(thank you|thanks for watching|you)[.!]?$/i.test(t)) return null;
  if (isPromptEcho(t)) return null;
  if (FILLER_ONLY.test(t)) return null;
  if (isUnclearShortClip(t, durationSec)) return null;
  return t;
}

// Speech models turn breaths and room noise into polite filler. Never a real message.
const FILLER_ONLY = /^(?:(?:uh+|um+|hmm+|mm+|ah+|oh+|one (?:sec|second|moment)|just (?:a )?(?:sec|second|moment)|wait(?: a (?:sec|second|moment))?|bye|okay then)[.!?,\s]*)+$/i;

// A very short clip that produced one or two words is almost always noise.
// Real one-word answers people do send by voice (yes/no/hello) stay valid.
const SHORT_CLIP_SECONDS = Number(process.env.VOICE_SHORT_CLIP_SECONDS) || 3;
const MIN_CLIP_SECONDS = Number(process.env.VOICE_MIN_CLIP_SECONDS) || 0.6;
const SHORT_VALID = /^(?:haan|han|ha|haanji|yes|yeah|yep|no|nahi|nahin|nhi|ok|okay|theek hai|thik hai|sahi hai|hello|hi|hey|namaste|sat sri akal|sat shri akal|ji|ji haan|done|ho gaya|bik gaya|sold|pin nahi)[.!?,\s]*$/i;

function isUnclearShortClip(text, durationSec) {
  if (durationSec == null || durationSec >= SHORT_CLIP_SECONDS) return false;
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length > 2) return false;
  return !SHORT_VALID.test(String(text).trim());
}

/**
 * Length in seconds of an Ogg/Opus clip (WhatsApp voice notes), read from the
 * last Ogg page's granule position (Opus always counts in 48 kHz samples).
 * Returns null for any other container or if it can't be read.
 */
function oggOpusDurationSeconds(buffer) {
  try {
    if (!buffer || buffer.length < 27 || buffer.toString('latin1', 0, 4) !== 'OggS') return null;
    const idx = buffer.lastIndexOf('OggS');
    if (idx < 0 || idx + 14 > buffer.length) return null;
    const granule = buffer.readBigUInt64LE(idx + 6);
    if (granule === 0xFFFFFFFFFFFFFFFFn) return null;
    const seconds = Number(granule) / 48000;
    return Number.isFinite(seconds) && seconds > 0 && seconds < 3600 ? seconds : null;
  } catch {
    return null;
  }
}

async function callTranscription({ buffer, mimeType, model, fetchImpl }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), fileNameFor(mimeType));
  form.append('model', model);
  form.append('prompt', TRANSCRIBE_PROMPT);
  form.append('response_format', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`transcription ${res.status}: ${detail.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return data?.text || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads a WhatsApp voice note and returns its transcript, or null when
 * it can't be understood (silence, too large, API down). Never throws.
 *
 * `download` is downloadWhatsAppMedia from agentIntakeController.js (passed
 * in to avoid a require cycle and to keep this testable).
 */
async function transcribeVoiceNote({ mediaId, mimeType, download, fetchImpl = fetch }) {
  if (!isVoiceEnabled() || !mediaId) return null;
  try {
    const buffer = await download(mediaId);
    if (!buffer || !buffer.length) return null;
    if (buffer.length > MAX_AUDIO_BYTES) {
      console.warn(`[voice] skipped ${mediaId}: ${buffer.length} bytes is over the ${MAX_AUDIO_BYTES} cap`);
      return null;
    }

    // Clips shorter than a fraction of a second are a stray tap, not speech:
    // don't pay for them or risk a hallucinated sentence.
    const durationSec = oggOpusDurationSeconds(buffer);
    if (durationSec != null && durationSec < MIN_CLIP_SECONDS) {
      console.log(`[voice] ${mediaId} -> too short (${durationSec.toFixed(2)}s), treated as unclear`);
      return null;
    }

    const model = process.env.VOICE_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
    let text;
    try {
      text = await callTranscription({ buffer, mimeType, model, fetchImpl });
    } catch (err) {
      // An unknown/unavailable model name comes back as a 4xx; whisper-1 is
      // the long-standing model every account has.
      if (model !== FALLBACK_MODEL && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
        console.warn(`[voice] ${model} failed (${err.message}); retrying with ${FALLBACK_MODEL}`);
        text = await callTranscription({ buffer, mimeType, model: FALLBACK_MODEL, fetchImpl });
      } else {
        throw err;
      }
    }

    const transcript = cleanTranscript(text, { durationSec });
    console.log(`[voice] ${mediaId} (${durationSec != null ? `${durationSec.toFixed(1)}s` : 'length unknown'}) -> ${transcript ? JSON.stringify(transcript.slice(0, 120)) : 'no usable speech'}`);
    return transcript;
  } catch (err) {
    console.error(`[voice] transcription failed for ${mediaId}:`, err.message);
    return null;
  }
}

/** Reply when a voice note couldn't be understood. */
function voiceNotUnderstoodMessage(lang) {
  return lang === 'en'
    ? "🎤 Sorry, I couldn't make out that voice note. Please send it again a little slower, or type the message."
    : '🎤 Maaf kijiye, voice note samajh nahi aaya. Thoda dheere dobara bhejein, ya message type kar dein.';
}

module.exports = { transcribeVoiceNote, voiceNotUnderstoodMessage, cleanTranscript, isPromptEcho, oggOpusDurationSeconds, fileNameFor, isVoiceEnabled, TRANSCRIBE_PROMPT };
