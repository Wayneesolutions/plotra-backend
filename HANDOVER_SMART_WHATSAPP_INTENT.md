# Handover: Smart WhatsApp intent routing for agents

## Problem
Every free-text message from a registered agent went straight into listing intake, unless it exactly matched a keyword ("yes", "payment", "new listing"). Messages like "meri listings dikhao", "model town wala plot bik gaya", "plan kitne ka hai" or "hello" got the reply "Property ka address kya hai?". Approvals had to be an exact phrase, so "haan bilkul sahi hai publish kar do" was treated as a correction.

## What changed
| File | Change |
|---|---|
| `src/services/agentIntentService.js` (new) | GPT-4o-mini classifier + routing + small reply handlers |
| `src/controllers/webhookController.js` | Agent text messages pass through `routeAgentText` before intake. Buyer messages on a dealer's own number use the AI search intent first (keyword check kept as fallback). |
| `src/controllers/agentIntakeController.js` | `handleAgentIntakeMessage` accepts optional `forceApproval` / `forceNewListing`; they only widen the existing keyword checks |
| `src/services/buyerSearchService.js` | Exports `extractBuyerIntent` |
| `test/agentIntentService.test.js` (new) | 12 unit tests for routing + listing matching |

## Intents an agent can now use in plain language (English / Hindi / Punjabi / Hinglish)
- **Add or correct a listing** → existing intake flow (unchanged)
- **Approve preview** ("haan sab theek hai, publish karo") → existing approval path
- **Start another listing** → existing new-listing path
- **My listings** → numbered list of their listings with links
- **Mark sold / still available** ("number 2 bik gaya", "dugri wali kothi sold") → sends the EXISTING `sold:<id>` / `available:<id>` buttons. Nothing changes until the agent taps.
- **I've paid** → existing receipt flow
- **Plan / payment status** → current package, status and QR, or the package menu
- **Find a property for a client** → searches the agent's own tenant inventory (no marketplace lead logging)
- **Help / greeting / unclear** → help menu instead of opening an empty draft

## Safety rules built in
1. Any LLM error, timeout, missing key or junk output → old flow, exactly as before.
2. While a listing is in progress, it needs ≥0.8 confidence to leave intake, so short answers like "55 lakh" or "Ludhiana" stay listing info.
3. Approval is only forced when a preview is actually waiting and confidence ≥0.85.
4. No listing is ever changed by the classifier. Destructive actions always go through a button tap.
5. Photos, location pins, button taps, receipt photos and numeric package picks run before the router, unchanged.

## Config (all optional)
| Env var | Default | Purpose |
|---|---|---|
| `AGENT_INTENT_ROUTER` | `on` | Set `off` to disable instantly (no deploy needed beyond restart) |
| `AGENT_INTENT_MODEL` | `gpt-4o-mini` | Model used for classification |
| `AGENT_INTENT_TIMEOUT_MS` | `6000` | Fails open to old flow after this |

Uses the existing `OPENAI_API_KEY`. No migrations.

## Cost
One extra short GPT-4o-mini call per agent text message (roughly ₹0.02–0.05 each). Photos, pins and button taps don't trigger it.

## Deploy
Normal flow: merge → on EC2 `git pull && pm2 restart api --update-env`. No migration, no frontend change.

## QA checklist (WhatsApp, as a registered agent)
- [ ] "hi" / "sat sri akal" → greeting, no draft created
- [ ] "meri listings dikhao" → list with numbers
- [ ] "number 1 bik gaya" → Yes/No buttons; tap "Haan, bik gayi" → listing marked sold
- [ ] "plan kitne ka hai" → package info
- [ ] "koi 200 gaj plot hai dugri mein" → matches from own inventory
- [ ] Mid-listing: bot asks price → reply "55" → still treated as price
- [ ] Preview waiting → "haan bilkul sahi hai publish kar do" → published
- [ ] Preview waiting → "theek hai par price 60 lakh karo" → correction, not approval
- [ ] Set `AGENT_INTENT_ROUTER=off`, restart → behaviour identical to before

## Not done / follow-ups
- Voice notes (audio messages) are still ignored by the webhook. Adding Whisper transcription in front of this router would let agents speak instead of type.
- Agent inventory search is own-tenant only. Cross-dealer search is a business decision.
- `npm test` (`node --test test/`) fails on Node 22 because it treats `test/` as a file. Use `node --test test/*.test.js test/locality/*.test.js` or update the script.
