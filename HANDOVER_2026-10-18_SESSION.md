# Plotraa handover: everything built on 18 Oct 2026

**For:** Sant (review, merge, deploy) · **From:** Pankaj's session with Claude
**Status:** 4 PRs open, none merged yet. Detailed per-feature notes: `HANDOVER_PIN_BLUR_VOICE.md` and `HANDOVER_PLOTRAA_ASSISTANT.md` (both in this repo).

---

## 1. The 4 PRs and merge order

The PRs are **stacked**: merge strictly in this order, or later ones will show earlier commits too.

| # | Repo | PR | What | Base |
|---|---|---|---|---|
| 1 | plotra-backend | [#58](https://github.com/Wayneesolutions/plotra-backend/pull/58) | Location pin with every listing, voice notes, fresh-DB migration fix, `npm test` fix | `main` |
| 2 | plotra-frontend | [#41](https://github.com/Wayneesolutions/plotra-frontend/pull/41) | Live listings: blur everything except the property | `main` |
| 3 | plotra-backend | [#59](https://github.com/Wayneesolutions/plotra-backend/pull/59) | Plotraa Assistant: first-message welcome, conversational joining, dealer guidance, support alerts | `claude/listing-pin-blur-voice` (#58) |
| 4 | plotra-frontend | [#42](https://github.com/Wayneesolutions/plotra-frontend/pull/42) | Admin → Support tab | `claude/listing-pin-blur-voice` (#41) |

After #58 is merged: if its branch is deleted on merge, GitHub retargets #59 to `main` by itself; otherwise edit #59 and change its base to `main` before merging. Same for #41 → #42.

---

## 2. What each one does (in plain words)

### PR #58 (backend): location pin + voice notes
- **Location pin with every listing.** After the address, the bot asks every dealer for the exact location and explains how: at the property → *Send your current location*; elsewhere → move the map, drop the pin on the house/plot; can't → reply "pin nahi" and drag the pin on the preview. Asked once, never blocks. A pin sent at any time (even as the first message) is kept and becomes the final location over any geocode. WhatsApp doesn't deliver *live* location to businesses, so we ask for "current location" (same GPS point).
- **Voice notes** from dealers and buyers are transcribed (OpenAI `gpt-4o-mini-transcribe`, falls back to `whisper-1`) and handled exactly like typed text everywhere. Unclear audio → "voice note samajh nahi aaya, dobara bhejein ya type karein".
- **Fixes:** `migrate:latest` on an empty DB no longer fails at `20260825_04` (column created before the insert). `npm test` works on Node 22. Reply language no longer flips to English after a pin.

### PR #41 (frontend): privacy blur
- On a **live** listing, Street View is frozen facing the property and the road and neighbouring houses are blurred/dimmed; only an oval on the property stays sharp, labelled "🔒 Only the property is shown". Before approval the dealer still sees the full movable views to fix the pin.
- Link previews (WhatsApp/Facebook) no longer use the unblurred street image.

### PR #59 (backend): Plotraa Assistant
- **First message from anyone** (even "hi") on the Plotraa number → short welcome + three paths: dealer (join), buyer (find), owner (sell). On a dealer's own number it greets for that dealer.
- **Joining in any wording** ("main dealer hoon", "kaise judein?", "join as agent"). Questions mid-signup are answered; the system (not the AI) asks only for what's missing (full name, area/city) and confirms "✅ Ho gaya! … approval ke liye bhej diya". Request lands in Admin → Agent Signups as before. Pending/rejected applicants are recognised.
- **On approval:** guided welcome in their language (first listing in 3 steps, ask anything, dashboard login), then the plan menu.
- **Registered dealers:** answers how/why questions, explains mistakes using their real state (listing step, what the bot is waiting for, payment, plan), reminds the pending step.
- **Buyers / owners:** owners on the Plotraa number → Seller Leads queue; a dealer's customer asking for a call → lead in that dealer's inbox.
- **No hard selling:** answers what's asked, plans/prices/discounts read live from the `plans` table, same for everyone, never invents discounts/trials.
- **Support alerts:** dealer problem, complaint or call-back request → support request + team alert (WhatsApp template + email), max once per 6h per person.
- Falls back to the old fixed replies / old step-by-step signup if the AI is unavailable.

### PR #42 (frontend): Admin → Support tab
- Open / Contacted / Closed queue: who, WhatsApp + Call buttons, summary, last message, team notes, and "View chat" with the recent WhatsApp conversation.

---

## 3. Database migrations (all additive, all have `down`)

| Migration | PR | Adds |
|---|---|---|
| `20261018_01_draft_pending_location_pin.js` | #58 | `agent_listing_drafts.pending_pin_lat/lng`, `location_pin_requested_at` |
| `20261018_02_assistant_and_support_requests.js` | #59 | tables `assistant_messages`, `support_requests` |

Also edited (safe on existing DBs, they've already run): `20260825_04_tier_plans.js`, `20260830_01_dedicated_whatsapp_numbers.js`.

---

## 4. Environment variables (all optional; add to EC2 `.env`)

| Variable | Default | Needed for |
|---|---|---|
| `VOICE_NOTES` | `on` | `off` ignores voice notes |
| `VOICE_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | try `gpt-4o-transcribe` if Punjabi quality is weak |
| `VOICE_TRANSCRIBE_TIMEOUT_MS` | `25000` | |
| `PLOTRAA_ASSISTANT` | `on` | `off` = old fixed replies |
| `PLOTRAA_ASSISTANT_MODEL` | `gpt-4o-mini` | |
| `PLOTRAA_ASSISTANT_TIMEOUT_MS` | `15000` | |
| `PLOTRAA_WHATSAPP_DISPLAY` | `+91 93951 90000` | number the bot tells people |
| `PLOTRAA_TRIAL_OFFER` | empty | **Pankaj to give one line**, e.g. "7-day free trial for every new agent" |
| `SUPPORT_ALERT_PHONES` | empty | **required** for team WhatsApp alerts (comma-separated) |
| `SUPPORT_ALERT_TEMPLATE_NAME` / `_LANG` | empty / `en` | **strongly recommended**, see below |
| `SUPPORT_ALERT_EMAILS` | all super_admins | needs SMTP configured |

All AI features use the existing `OPENAI_API_KEY`. No new keys.

**WhatsApp alert template:** WhatsApp only allows free-text messages to numbers that messaged us in the last 24h, so team alerts can silently not arrive. Create and get approved in Meta a utility template with 3 body variables, e.g.
`Plotraa support: {{1}} needs help. Phone: {{2}}. Details: {{3}}. Open Admin > Support.`
then set `SUPPORT_ALERT_TEMPLATE_NAME` to its name.

---

## 5. Deploy steps

1. Merge **#58**, then on EC2:
   `git pull && npm ci && npm run migrate && pm2 restart all --update-env`
2. Merge **#41**, rebuild + deploy frontend.
3. Merge **#59**, then on EC2:
   `git pull && npm ci && npm run migrate` → add the env vars above → `pm2 restart all --update-env`
4. Merge **#42**, rebuild + deploy frontend.

`pm2 restart all` matters: the API and the `agentIntake` and `geo` workers changed.

---

## 6. Test on a real phone after deploy (not possible in the sandbox)

**Location + voice (#58, #41)**
- [ ] New listing by text: bot asks for location after the address; send current location → listing created with that pin.
- [ ] Reply "pin nahi" → listing still created; preview says drag the pin.
- [ ] Send a pin as the very first message, then the details.
- [ ] Send a Punjabi voice note with property details → listing flow continues normally.
- [ ] Buyer voice note to the Plotraa number → search results / assistant reply.
- [ ] Open a live listing on iPhone (Safari) and Android (Chrome): only the property is sharp, Street View doesn't rotate.

**Assistant (#59, #42)**
- [ ] From a new number: "hi" → welcome with the three paths.
- [ ] "main property dealer hoon, judna hai" → asks name + area; send name only → asks area only; ask "kitna kharcha hai?" → answered + reminder; send area → "Ho gaya!" and it appears in Admin → Agent Signups.
- [ ] Approve it → welcome with 3 steps + login + plan menu arrive.
- [ ] As a registered agent: "pin kyun chahiye?", "listing live kyun nahi hui?" → sensible answers.
- [ ] As an agent: "payment kar di phir bhi listing add nahi ho rahi" → support request in Admin → Support + WhatsApp alert to team numbers + email.
- [ ] From a new number: "meri Dugri wali kothi bechni hai 1.5 crore" → row in Admin → Seller Leads.
- [ ] Ask for a discount → bot says prices are the same for everyone.
- [ ] Send 20-30 real questions (Hinglish + Punjabi) and read the answers. Fix wrong/vague facts by editing `src/assistant/plotraaKnowledge.js` (plain text).

---

## 7. Verified in the sandbox

- Unit tests: **111/111** pass (`npm test`).
- Full migration chain (56) on an empty Postgres 16, plus `down`/`up` of both new migrations.
- End-to-end flows against real Postgres + Redis with Meta/OpenAI mocked: pin flow (pin first / details first / duplicate delivery / payment-blocked), voice note via webhook (success + failure for agent and buyer), assistant (question with live plans, memory, support + alerts + dedupe, seller lead via webhook, dealer lead, AI-down fallback, admin API), joining ("hi" → join → name → question → area → admin queue → approval welcome; literal "join as agent"; rejected applicant).
- Frontend `vite build` for both PRs; blur and Support tab rendered in headless Chromium with test data.

## 8. Known limits / open decisions

- **AI answer quality** with the real model is untested (see §6). Model choice and knowledge text are config/plain text, easy to tune.
- **Blur:** the bottom ~24px (Google logo/copyright) can't be covered under Maps terms. Exact lat/lng are still in the public API (needed for Street View); fully hiding them means server-side pre-blurred images.
- **Agent attribution:** new agents on the shared number still go under the oldest active tenant (unchanged rule). Decide if Plotraa should have its own "direct agents" tenant.
- **Onboarding-number form** (`WHATSAPP_ONBOARDING_NUMBER`, `whatsappSignupService.js`) is untouched and still step-by-step; only active if that env var is set.
- Assistant never messages anyone unprompted (by design). After the team contacts someone, the assistant keeps answering them normally.
- A pin wins over the address text; if a dealer corrects the address to a different property, they should send a new pin.

## 9. Non-code work from the same session

- **Commercial scripts** (single female presenter to camera): agents (listing), agents (leads), buyers & sellers. The buyers & sellers script with shot table and pre-shoot checklist is in the Claude doc "Plotraa Commercial Scripts – Buyers & Sellers"; the two agent scripts are in Pankaj's chat. Before shooting, make sure the ad claims match the product: ratings are set by the Plotraa team (not customer reviews yet) and seller leads are assigned by the admin (say "verified local dealer", not "best dealer").
- **Repo review:** both `plotra-backend` and `plotra-frontend` are **public on GitHub**. No secrets were found committed, but the full business code is visible; consider making them private (also relevant for the software copyright filing).
- **Still pending from before:** Excel bulk listing upload (super-admin) is not built yet.
