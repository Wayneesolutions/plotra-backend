# Handover: Plotraa Assistant + support alerts

Stacked on `claude/listing-pin-blur-voice` (PR #58 / frontend #41). Merge those first, then this backend PR, then its frontend PR.

## What it does

A conversational WhatsApp assistant that talks like a person instead of sending fixed menus, for three kinds of people:

| Who | Where they write | What the assistant does |
|---|---|---|
| **Registered agent** | Plotraa number | Answers "how/why" questions, explains what went wrong using their real state (listing in progress, what the bot is waiting for, payment status, plan, listing counts), guides the listing steps, and after answering reminds them of any pending step. |
| **New contact** | Plotraa number, unknown phone | Works out if they're a dealer, buyer or owner. Dealers: explains how Plotraa works and the plans, honestly, no hard selling; to join they reply "join as agent". Owners: takes type/area/price and creates a **seller lead** for the admin queue. Buyers: asks what they need. |
| **Dealer's customer** | A dealer's own number, unknown phone | Helps them say what they need; if they want a call, creates a **lead for that dealer** (shows in the dealer's leads inbox). Never pitches Plotraa plans. |

It only talks. Listing, approving, marking sold and payments stay with the existing handlers; the assistant tells people the exact words to send.

### First message and joining (the most important part)
- **First message from anyone** (even just "hi") on the Plotraa number gets a short welcome: what Plotraa is, and the three paths (dealer → just say you want to join; buyer → tell type/area/budget; owner → tell type/area/price). If the first message already shows what they want, it skips the menu and helps directly. A dealer's own number greets on behalf of that dealer.
- **Joining is not tied to a keyword anymore.** "main property dealer hoon", "mujhe bhi listing daalni hai", "kaise judein?" all start it ("join as agent" still works). The assistant explains what happens next; the system (not the AI) adds the exact line of what's still needed: full name and the area/city they work in. Name/area are taken from whatever they say, read by the assistant and cross-checked by the existing signup extractor, so nobody is asked twice.
- **Questions while joining are answered** ("kitna kharcha hai?", "kya karna padega?") and followed by a one-line reminder of what's still needed. Once both are in, they get "✅ Ho gaya! … team ko approval ke liye bhej diya" and the request appears in Admin → Agent Signups as before.
- After submitting, the assistant knows the request is pending and answers accordingly (no restarting). A previously rejected applicant is handled kindly and routed to the team (support request) instead of a new signup.
- **On approval** the agent gets a guided welcome in their language: the 3 steps for the first listing (details/voice note → location pin → "haan" on the preview), that they can ask anything in their own words, plus the dashboard login (super-admin path); the plan menu follows as before.
- Fallback: if the AI is unavailable, the old step-by-step signup runs unchanged.
- Not changed: the separate onboarding-number form (`WHATSAPP_ONBOARDING_NUMBER`, `whatsappSignupService.js`), used only if that env var is set.

### Rules built into the prompt (`src/assistant/plotraaKnowledge.js`)
- Guide, not salesperson: answers what's asked, at most one gentle next step, no pressure or urgency.
- Plans, prices and discounts come **live from the `plans` table** (same as the website/admin Plans tab). Everyone gets the same plans; it never invents or negotiates a discount, trial or refund.
- Trial/offer: set `PLOTRAA_TRIAL_OFFER` to one line (e.g. "7-day free trial for every new agent") and it quotes exactly that. Empty = it says the team shares current offers.
- No promises of sales or extra leads, never asks for passwords/OTP/bank details, never shares other people's details.
- Replies in the person's own language/script, WhatsApp-short.
- To change what it knows, edit `PRODUCT` in `plotraaKnowledge.js` (plain text, only things the product really does).

## Support requests ("someone needs a human")

Raised when an agent reports a problem/complaint or asks for a person, when a new contact asks for a call/demo, or (if the AI is down) when an agent's message clearly asks for help.

- One open request per phone; repeat messages update it (count, latest message, complaint outranks question). Someone writing again after being contacted reopens it.
- **Team alert** (at most once per 6h per person):
  - WhatsApp to every number in `SUPPORT_ALERT_PHONES`. **Important:** WhatsApp only allows free text to numbers that messaged the business in the last 24h. Create an approved template with 3 variables ({{1}} who, {{2}} phone, {{3}} what) and set `SUPPORT_ALERT_TEMPLATE_NAME`, otherwise alerts can silently not arrive.
  - Email to `SUPPORT_ALERT_EMAILS`, or every super_admin user if unset (needs SMTP configured).
- **Admin → Support tab** (frontend PR): Open / Contacted / Closed, WhatsApp + Call buttons, the summary, their last message, team notes, and "View chat" with the recent WhatsApp conversation so whoever calls knows the context.

## Routing changes
- Agent intent router has two new intents: `question` and `support`, both answered by the assistant. An unclassified ("other") message with no listing in progress now goes to the assistant instead of the help menu. Mid-listing, these need ≥0.8 confidence, so "55 lakh" stays a listing answer. A literal "help" still gets the menu.
- Unknown numbers: property searches are still answered by the existing search first; anything else goes to the assistant instead of the fixed intro (which remains the fallback).
- Not changed: the "join as agent" signup flow (still step by step), lead threads with buyers who came from a listing link (existing listing AI), receipts, buttons, photos, pins.

## Files
New: `src/services/assistantService.js`, `src/assistant/plotraaKnowledge.js`, `src/services/agentSignupService.js`, `src/services/supportRequestService.js`, `src/controllers/supportRequestController.js`, migration `20261018_02_assistant_and_support_requests.js`, `test/assistantService.test.js`.
Changed: `agentIntentService.js` (+ tests), `agentSignupController.js` (assistant-first joining, welcome on approval), `webhookController.js`, `agentMessagingService.js` (template passthrough), `emailService.js` (alert email), `routes/admin.js`, `.env.example`.
Frontend: `src/components/AdminSupportRequests.jsx` (new), `AdminPanel.jsx` (tab).

## Config
| Env var | Default | Purpose |
|---|---|---|
| `PLOTRAA_ASSISTANT` | `on` | `off` = old fixed replies |
| `PLOTRAA_ASSISTANT_MODEL` | `gpt-4o-mini` | Try `gpt-4o` if answers feel weak (~15x cost) |
| `PLOTRAA_ASSISTANT_TIMEOUT_MS` | `15000` | Falls back to the old reply after this |
| `PLOTRAA_TRIAL_OFFER` | empty | The one-line trial/offer everyone gets |
| `PLOTRAA_WHATSAPP_DISPLAY` | `+91 93951 90000` | Number the assistant tells people |
| `SUPPORT_ALERT_PHONES` | empty | Team WhatsApp numbers, comma-separated |
| `SUPPORT_ALERT_TEMPLATE_NAME` / `_LANG` | empty / `en` | Approved alert template (see above) |
| `SUPPORT_ALERT_EMAILS` | super_admins | Alert emails |

Cost: one GPT-4o-mini call per assistant reply, roughly ₹0.05–0.15 (bigger prompt than the intent router because it carries the product knowledge and plans).

## Deploy
1. Merge, `npm ci && npm run migrate` (1 additive migration: `assistant_messages`, `support_requests`).
2. Set at least `SUPPORT_ALERT_PHONES` and ideally `SUPPORT_ALERT_TEMPLATE_NAME`; set `PLOTRAA_TRIAL_OFFER` if there is one.
3. `pm2 restart all --update-env`. Deploy the frontend for the Support tab.

## What was verified
- `npm test`: 111/111 (new: joining follow-ups, approval welcome, output parsing, plan formatting, no-hard-sell/same-price prompt rules, trial text, alert text, support-keyword fallback, new routing).
- Full migration chain on an empty Postgres 16 (56) + `down`/`up` of the new one.
- End to end against real Postgres + Redis with OpenAI mocked: agent question answered with live plans and their context; follow-up carries conversation memory; agent problem creates one support request and 2 template alerts; a repeat bumps it (count 2, upgraded to complaint) without re-alerting; an owner on the platform number via the webhook creates a seller lead; a dealer's customer asking for a call creates a lead for that dealer and no support alert; with the AI down, "call karo" still reaches the team while a plain question falls back to the old reply; admin list/detail(conversation)/contacted/closed.
- Joining end to end (webhook → assistant → signup row → admin queue → approval): "hi" gets the welcome; "main property dealer hoon…" opens a signup and asks name + area in Hinglish; a bare name the AI missed is still captured by the extractor; a cost question mid-signup is answered with the area reminder; the area completes it ("Ho gaya!") and it shows in Admin → Agent Signups; a later "kab approve hoga?" isn't asked anything again; literal "join as agent" always starts; approval sends the 3-step welcome with login; a rejected applicant goes to support without a new signup.
- Frontend `vite build`; Support tab rendered with sample data in headless Chromium.

## NOT verified
- **Answer quality with the real model.** Before switching it on for everyone, send it 20-30 real questions in Hinglish/Punjabi (as an agent and from an unknown number) and read the answers. Adjust `PRODUCT` text where it's vague.
- Real WhatsApp alert delivery (template approval is a Meta-side step).
- Support tab inside the real admin panel with a real login.

## Known limits / follow-ups
- New agents are still filed under the receiving number's tenant, or the oldest active tenant on the shared number (unchanged behaviour); the super-admin reviews every request.
- The assistant doesn't send follow-ups by itself (no unprompted messages), by design.
- No automatic hand-back: after the team contacts someone, the assistant keeps answering their messages normally.
