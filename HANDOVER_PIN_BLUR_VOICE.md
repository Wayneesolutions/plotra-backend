# Handover: location pin at listing time, privacy blur, voice notes

Backend PR (this repo) + frontend PR (plotra-frontend, branch `claude/listing-pin-blur-voice`). Merge **backend first**, run the migration, then frontend.

## 1. Location pin asked with every WhatsApp listing

**Before:** the bot only asked for a pin when geocoding came back weak, and a pin sent before the listing existed was rejected ("start a listing first").

**Now:**
- Once the address/type are in, the bot asks every agent for the property's exact location and explains both ways to send it:
  - at the property: ➕/📎 → Location → *Send your current location*
  - somewhere else: ➕/📎 → Location → move the map, put the pin on the house/plot, send
  - can't share: reply "pin nahi" / "no pin" → we place it from the address and they drag the pin on the preview link (existing drag-to-fix + Save)
- Asked **once per listing**; never blocks. If the address has no plot/house number, the same message also asks for it (replaces the old separate "add a number" question).
- A pin is accepted **at any point**, even as the first message. It's held on the draft (`pending_pin_lat/lng`) and written onto the listing at insert, where `geoEnrichmentWorker.js` uses it as the final coordinate over every geocode.
- If the address is already in and we were waiting on the pin, the pin immediately re-queues extraction, so the listing gets created without the agent typing anything else.
- No second "please share a pin" nag after a weak geocode if we already asked at listing time (the preview's "rough guess, drag the pin" warning still goes out).
- Payment-blocked agents can't start a new listing by sending a pin (same rule as text).

**Live location:** WhatsApp's Cloud API does not deliver *live* location shares to business numbers. The message therefore asks for "Send your current location", which is the same GPS point. If an agent shares live location anyway, the webhook already reads it if Meta ever sends it.

Files: `src/workers/agentIntakeWorker.js`, `src/controllers/agentIntakeController.js` (`holdPinOnDraft`), `src/services/listingService.js`, `src/workers/geoEnrichmentWorker.js`, `src/services/agentMessagingService.js` (language detection skips the `[location pin shared: …]` marker, which was flipping Hinglish chats to English), migration `20261018_01_draft_pending_location_pin.js`.

## 2. Blur everything except the property (frontend PR)

On a **live** listing page (`status = 'active'`, i.e. after the dealer approves), the Street View is:
- frozen facing the property (no rotate, zoom, or walking down the road; snaps back if anything moves it)
- blurred and dimmed everywhere except a soft oval in the middle where the property is, so the road and neighbouring houses aren't readable
- labelled "🔒 Only the property is shown"

Pre-approval the dealer still sees the full, movable satellite + street view to check and drag the pin. Satellite was already hidden on live listings. Social/WhatsApp link previews no longer use the raw street image (dealer photos only).

Files (frontend): `src/components/PropertyMapMedia.jsx`, `src/components/PropertyView.jsx`.

## 3. Voice notes from dealers and buyers

Any WhatsApp voice note (or audio file) from an agent or a buyer is downloaded, transcribed with OpenAI (`gpt-4o-mini-transcribe`, falls back to `whisper-1`), and the transcript is handled exactly like a typed message: listing intake, the smart intent router, buyer search, lead threads. The prompt keeps the transcript in Roman Hinglish and primes Punjab real-estate words (gaj, marla, kanal, kothi, localities).

If it can't be understood (silence, API down, file > 8 MB) the sender gets: "🎤 Maaf kijiye, voice note samajh nahi aaya…" and nothing else happens. The agent help menu now mentions voice notes.

Files: `src/services/voiceNoteService.js` (new), `src/controllers/webhookController.js`, `src/services/agentIntentService.js` (help text).

| Env var | Default | Purpose |
|---|---|---|
| `VOICE_NOTES` | `on` | `off` disables transcription (voice notes ignored as before) |
| `VOICE_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | Transcription model |
| `VOICE_TRANSCRIBE_TIMEOUT_MS` | `25000` | Per-request timeout |

Uses the existing `OPENAI_API_KEY`. Cost is roughly ₹0.25 per minute of audio.

## 4. Fixed: fresh database couldn't be built

`migrate:latest` on an empty database failed at `20260825_04_tier_plans.js` (it inserted `plans.max_whatsapp_numbers` before `20260830_01` created the column). `04` now creates the column when missing and `20260830_01` only adds it when missing. Existing databases are unaffected (both migrations already ran there).

## Deploy
1. Merge backend, then on EC2: `git pull && npm ci && npm run migrate` (one additive migration).
2. `pm2 restart all --update-env` (API + `agentIntake` + `geo` workers all changed).
3. Merge frontend, rebuild, deploy.

## What was verified
- Full migration chain on an empty Postgres 16 (55 migrations), plus `down`/`up` of the new one.
- Pin flow against real Postgres + Redis: pin first then details; details first then pin (extract job queued); duplicate webhook delivery ignored; held pin copied onto the listing (`location_source='agent_pin'`); listing without a pin unchanged; payment-blocked agent; reply language stays Hinglish.
- Voice flow through `handleInboundWhatsApp` with Meta + OpenAI mocked: agent voice note lands in the draft as text; transcription failure sends the "samajh nahi aaya" reply for agents and buyers.
- `node --test test/*.test.js test/locality/*.test.js`: 99/99 pass (8 new voice tests). `npm test` now uses that same command (it was broken on Node 22)..
- Frontend `vite build` passes; the blur overlay was rendered in headless Chromium on a test street image at desktop and phone width.

## NOT verified (please check after deploy)
- Real WhatsApp: send a pin, a "pin nahi", and a Punjabi voice note from a real phone.
- The blur on a real Google Street View panorama in Safari/iPhone and Chrome/Android (the overlay uses `backdrop-filter`; browsers without it get a near-solid dark tint instead).
- Transcription quality on real Punjabi audio. If it's weak, try `VOICE_TRANSCRIBE_MODEL=gpt-4o-transcribe` (better, ~2x cost).

## Known limits
- The bottom ~24 px of the Street View stays unblurred: Google's logo and copyright line are there and Maps Platform terms don't allow covering them. A thin strip of road can show there.
- The public listing API still returns the exact `lat/lng` (Street View needs it in the browser). The blur stops people *seeing* the surroundings; a technical user could still read the coordinates. Hiding them fully means rendering a pre-blurred image on the server instead of live Street View.
- A pin wins over the address text. If an agent later corrects the address to a different property, they should send a new pin too.
