# Handover: WhatsApp chat QA round 2 (21 Oct 2026)

Branch `claude/inspiring-archimedes-bcqr2o`, backend only. No migration. 142 tests pass. Not tried against the live model, real WhatsApp or real OpenAI.

## 1. Items and what was done

| # | Item | Status | Change |
|---|---|---|---|
| 1 | Visitor flow: dealer or owner? | Fixed, **retest** | The assistant asks "Aap dealer hain ya property owner?" when unclear. Dealers also get `/request-access`, owners `/sell-property`, once per chat (`visitorFormLine` in `assistantService.js`; rules in `plotraaKnowledge.js`). |
| 2 | Duplicate draft when an address arrives with an open draft | Fixed (likely cause) | `src/utils/addressMatch.js`: the same address reordered or with extra parts is the same property. Different house/sector numbers or a different locality is a new property. The `draft=` log line was never seen, so the cause is inferred. |
| 3 | Support raised twice, "Transaction query already complete", no confirmation | Fixed (inferred cause) | `serviceContext.js` rolled back the webhook transaction as soon as the sender hung up, so a slow reply failed mid-handler and the sender's retry ran the message again. Now it waits up to 45 s (`SERVICE_TRX_ABORT_GRACE_MS`) and commits. The reply is sent before chat history is saved, and the failure path no longer raises a second ticket. |
| 5 | Buyer search ignores size ("200 gaj") | Fixed | `buyerSearchService.js`: `parsePlotSize` converts gaj, sq yd, sq ft, marla, kanal to sq yards; +-10%. Unreadable listing sizes come after the matches. BHK is ignored. |
| 6 | A plain question creates a support ticket | Fixed | A plain question never raises a ticket, even if the model picks "support" (`isPlainQuestion`). The model-off fallback no longer treats "support number?" as a request. |
| 8 | Support number and upgrade steps missing | Fixed | Support number added (`PLOTRAA_SUPPORT_NUMBER`, default the Plotraa WhatsApp number). There is no self-serve upgrade: plan changes go to the team as a support request. The assistant never describes upgrade steps. |
| 9 | Discount reply too long | Fixed | Prompt rule (2 lines) plus `capShortReply` trims any discount reply over 280 characters at a sentence end. |
| 11 | Gurmukhi name and area gets only "swagat hai" | Fixed (likely cause), **retest** | A first message with only a name and area now starts a dealer signup. The follow-up lines are in Gurmukhi for Gurmukhi writers. |
| 12 | `knexfile.js` and `geo.js` not committed | Nothing to do | `knexfile.js` is already tracked and no `geo.js` exists in this repo. Check the other machine or repo. |

Items 4, 7 and 10 were not in the list and were not touched.

## 2. Product rules the assistant now states

- New agents get a free trial of 5 days and receive the payment QR for their plan.
- Payment is due by day 7. If unpaid, the service stops until it is paid.
- Pay by QR, or cash with a receipt photo; the team approves it.

## 3. Open issues

- **The 5-day trial and day-7 stop are not implemented in code.** `paymentReminderWorker.js` still works on a monthly cycle with reminders from day 28. The assistant now says the 5/7-day rule but nothing enforces it.
- The `serviceContext.js` change also affects admin routes: an aborted admin request now commits after the grace period instead of rolling back at once.
- Retest with the real model: items 1, 3, 11, plus Gurmukhi wording.

## 4. Files

`src/assistant/plotraaKnowledge.js`, `src/services/assistantService.js`, `src/services/agentSignupService.js`, `src/services/buyerSearchService.js`, `src/controllers/agentIntakeController.js`, `src/middleware/serviceContext.js`, new `src/utils/addressMatch.js`. Tests: `test/assistantService.test.js`, new `test/plotSizeAndAddress.test.js`.
