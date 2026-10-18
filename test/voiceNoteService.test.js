const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = 'test-key';
const { transcribeVoiceNote, cleanTranscript, fileNameFor } = require('../src/services/voiceNoteService');
const { parseInboundPayload } = require('../src/controllers/webhookController');

const fakeDownload = async () => Buffer.from('OggS fake opus bytes');

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, model: opts.body.get('model'), file: opts.body.get('file') });
    const r = responses.shift();
    return {
      ok: r.status === 200,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { impl, calls };
}

test('transcribes a voice note with the configured model', async () => {
  delete process.env.VOICE_TRANSCRIBE_MODEL;
  const { impl, calls } = fakeFetch([{ status: 200, body: { text: '  Model Town mein 200 gaj kothi, 1.2 crore  ' } }]);
  const text = await transcribeVoiceNote({ mediaId: 'm1', mimeType: 'audio/ogg; codecs=opus', download: fakeDownload, fetchImpl: impl });
  assert.strictEqual(text, 'Model Town mein 200 gaj kothi, 1.2 crore');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, 'gpt-4o-mini-transcribe');
  assert.match(calls[0].url, /audio\/transcriptions$/);
  assert.strictEqual(calls[0].file.name, 'voice.ogg');
});

test('falls back to whisper-1 when the primary model is rejected', async () => {
  const { impl, calls } = fakeFetch([
    { status: 400, body: { error: { message: 'model not found' } } },
    { status: 200, body: { text: 'Dugri wala plot bik gaya' } },
  ]);
  const text = await transcribeVoiceNote({ mediaId: 'm2', mimeType: 'audio/ogg', download: fakeDownload, fetchImpl: impl });
  assert.strictEqual(text, 'Dugri wala plot bik gaya');
  assert.deepStrictEqual(calls.map((c) => c.model), ['gpt-4o-mini-transcribe', 'whisper-1']);
});

test('returns null (never throws) on auth/rate-limit errors and API outages', async () => {
  for (const status of [401, 429, 500]) {
    const { impl, calls } = fakeFetch([{ status, body: {} }]);
    const text = await transcribeVoiceNote({ mediaId: 'm3', mimeType: 'audio/ogg', download: fakeDownload, fetchImpl: impl });
    assert.strictEqual(text, null);
    assert.strictEqual(calls.length, 1, `no fallback retry on ${status}`);
  }
});

test('returns null when the download fails or the file is too large', async () => {
  const failing = async () => { throw new Error('meta down'); };
  assert.strictEqual(await transcribeVoiceNote({ mediaId: 'm4', download: failing, fetchImpl: async () => { throw new Error('should not call'); } }), null);
  const huge = async () => Buffer.alloc(9 * 1024 * 1024);
  assert.strictEqual(await transcribeVoiceNote({ mediaId: 'm5', download: huge, fetchImpl: async () => { throw new Error('should not call'); } }), null);
});

test('can be switched off with VOICE_NOTES=off', async () => {
  process.env.VOICE_NOTES = 'off';
  try {
    const text = await transcribeVoiceNote({ mediaId: 'm6', download: fakeDownload, fetchImpl: async () => { throw new Error('should not call'); } });
    assert.strictEqual(text, null);
  } finally {
    delete process.env.VOICE_NOTES;
  }
});

test('cleanTranscript drops silence filler and keeps real speech', () => {
  assert.strictEqual(cleanTranscript(''), null);
  assert.strictEqual(cleanTranscript(' ... '), null);
  assert.strictEqual(cleanTranscript('Thank you.'), null);
  assert.strictEqual(cleanTranscript('haan'), 'haan');
  assert.strictEqual(cleanTranscript('ਮਾਡਲ ਟਾਊਨ'), 'ਮਾਡਲ ਟਾਊਨ');
});

test('fileNameFor maps WhatsApp audio types', () => {
  assert.strictEqual(fileNameFor('audio/ogg; codecs=opus'), 'voice.ogg');
  assert.strictEqual(fileNameFor('audio/mpeg'), 'voice.mp3');
  assert.strictEqual(fileNameFor('audio/mp4'), 'voice.m4a');
  assert.strictEqual(fileNameFor('audio/amr'), 'voice.amr');
  assert.strictEqual(fileNameFor(null), 'voice.ogg');
});

test('parseInboundPayload reads a Meta Cloud API voice note', () => {
  const body = {
    entry: [{ changes: [{ value: {
      metadata: { display_phone_number: '919395190000', phone_number_id: 'pn1' },
      contacts: [{ wa_id: '919876543210', profile: { name: 'Raju' } }],
      messages: [{ id: 'wamid.1', type: 'audio', audio: { id: 'AUDIO123', mime_type: 'audio/ogg; codecs=opus', voice: true } }],
    } }] }],
  };
  const parsed = parseInboundPayload(body);
  assert.strictEqual(parsed.audioId, 'AUDIO123');
  assert.strictEqual(parsed.audioMimeType, 'audio/ogg; codecs=opus');
  assert.strictEqual(parsed.mediaId, null, 'audio must not be treated as a property photo');
  assert.strictEqual(parsed.incomingText, undefined);
});
