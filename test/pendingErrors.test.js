const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = '';
process.env.PLOTRAA_ASSISTANT = 'off'; // exercise the no-model path: the lead must still be saved

// ---- stubs for the modules that open Redis queues ------------------------
const sent = [];
const msgPath = require.resolve('../src/services/agentMessagingService');
require.cache[msgPath] = { id: msgPath, filename: msgPath, loaded: true, exports: {
  enqueueAgentWhatsappSend: async (m) => { sent.push(m); },
  logAgentOutboundMessage: async () => {},
  detectDraftLanguage: async () => 'hi',
} };

// ---- tiny fake knex ------------------------------------------------------
function fakeKnex(state) {
  const knex = (table) => {
    const q = { table, conds: [], _raw: [] };
    const api = {
      where(c) { if (typeof c === 'object') q.conds.push(c); return api; },
      whereIn() { return api; },
      orderBy() { return api; },
      async first() {
        if (table === 'seller_leads') return state.sellerLeads.find((r) => r.phone === q.conds[0]?.phone && r.status === 'new') || undefined;
        if (table === 'users') return state.users.find((u) => u.id === q.conds[0]?.id);
        return undefined;
      },
      async update(patch) {
        if (table === 'pending_agent_signups') {
          let n = 0;
          for (const r of state.signups) if (r.phone === q.conds[0].phone && r.status === q.conds[0].status) { Object.assign(r, patch); n += 1; }
          return n;
        }
        if (table === 'seller_leads') {
          const row = state.sellerLeads.find((r) => r.id === q.conds[0]?.id);
          if (row) Object.assign(row, patch);
          return row ? 1 : 0;
        }
        if (table === 'listings') { state.listingUpdates.push(patch); return 1; }
        return 1;
      },
      insert(row) {
        const rec = { id: `r${Math.random()}`, status: 'new', ...row };
        if (table === 'seller_leads') state.sellerLeads.push(rec);
        return { returning: async () => [rec] };
      },
    };
    return api;
  };
  knex.raw = (s) => s;
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const { handleWithAssistant } = require('../src/services/assistantService');

test('a selling message during an open dealer signup saves a lead and cancels the signup', async () => {
  sent.length = 0;
  const state = { sellerLeads: [], signups: [{ phone: '+919876543210', status: 'pending', name: null }], users: [], listingUpdates: [] };
  const res = await handleWithAssistant(fakeKnex(state), {
    audience: 'visitor', phone: '919876543210', text: 'meri Dugri wali kothi bechni hai 1.5 crore', name: 'Raju',
  });
  assert.strictEqual(res.handled, true);
  assert.strictEqual(res.action, 'seller_lead');
  assert.strictEqual(state.sellerLeads.length, 1, 'seller lead saved');
  assert.strictEqual(state.sellerLeads[0].expected_price, '1.5 crore');
  assert.strictEqual(state.signups[0].status, 'cancelled', 'open dealer signup closed');
  assert.match(sent[0].messageBody, /dealer/i);
});

test('a second selling message updates the same lead instead of creating another', async () => {
  const state = { sellerLeads: [{ id: 'a', phone: '+919000000001', status: 'new', property_type: 'Villa', expected_price: null, size_text: null }], signups: [], users: [], listingUpdates: [] };
  await handleWithAssistant(fakeKnex(state), { audience: 'visitor', phone: '919000000001', text: 'kothi bechni hai, 200 gaj, 2 crore' });
  assert.strictEqual(state.sellerLeads.length, 1);
  assert.strictEqual(state.sellerLeads[0].expected_price, '2 crore');
  assert.strictEqual(state.sellerLeads[0].size_text, '200 gaj');
});

test('status check goes to the CURRENT users.phone of the responsible agent (renamed number)', async () => {
  const { sendStatusCheckPrompt } = require('../src/services/listingStatusCheckService');
  const state = { users: [{ id: 'u1', phone: '919111111111' }], sellerLeads: [], signups: [], listingUpdates: [] };
  const out = [];
  const listing = { id: 'L1', tenant_id: 't1', title: 'Kothi', created_by: 'u1', assigned_agent_id: null };
  await sendStatusCheckPrompt(fakeKnex(state), listing, { send: async (m) => out.push(m) });
  assert.strictEqual(out[0].phone, '919111111111');
  state.users[0].phone = '919222222222'; // the user's number is renamed
  await sendStatusCheckPrompt(fakeKnex(state), listing, { send: async (m) => out.push(m) });
  assert.strictEqual(out[1].phone, '919222222222', 'next check reaches the new number');
  // an agent with no phone is skipped, never sent to a stale value
  state.users[0].phone = null;
  assert.strictEqual(await sendStatusCheckPrompt(fakeKnex(state), listing, { send: async (m) => out.push(m) }), false);
  assert.strictEqual(out.length, 2);
});

test('an English question is answered in English even after a Hinglish conversation', () => {
  const { detectMessageLanguage } = require('../src/utils/replyLanguage');
  assert.strictEqual(detectMessageLanguage('what are your plans?'), 'en');
  assert.strictEqual(detectMessageLanguage('plans kya hain'), 'hi');
  assert.strictEqual(detectMessageLanguage('ok'), null, 'ambiguous: caller falls back to the conversation language');
  assert.strictEqual(detectMessageLanguage('Dugri'), null);
});

test('short filler transcripts from short clips are unclear; real short answers are kept', () => {
  const { cleanTranscript, oggOpusDurationSeconds } = require('../src/services/voiceNoteService');
  assert.strictEqual(cleanTranscript('One sec.', { durationSec: 1.4 }), null);
  assert.strictEqual(cleanTranscript('One sec.'), null, 'filler is dropped even with unknown length');
  assert.strictEqual(cleanTranscript('Okay then', { durationSec: 2 }), null);
  assert.strictEqual(cleanTranscript('Dugri plot', { durationSec: 2 }), null, '2 words in 2s with no clear meaning is unclear');
  assert.strictEqual(cleanTranscript('haan', { durationSec: 1 }), 'haan');
  assert.strictEqual(cleanTranscript('Hello', { durationSec: 1.2 }), 'Hello');
  assert.strictEqual(cleanTranscript('Dugri plot', { durationSec: 6 }), 'Dugri plot', 'a longer clip is trusted');
  assert.strictEqual(cleanTranscript('Mere paas Dugri mein 10 marla plot hai', { durationSec: 2.5 }), 'Mere paas Dugri mein 10 marla plot hai');

  // Duration read from the last Ogg page's granule position (48 kHz).
  const buf = Buffer.alloc(60);
  buf.write('OggS', 0, 'latin1');
  buf.write('OggS', 30, 'latin1');
  buf.writeBigUInt64LE(BigInt(48000 * 2), 36); // last page: 2 seconds
  assert.strictEqual(oggOpusDurationSeconds(buf), 2);
  assert.strictEqual(oggOpusDurationSeconds(Buffer.from('not ogg at all, just bytes')), null);
});
