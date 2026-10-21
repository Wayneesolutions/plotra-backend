# Handover: WhatsApp chat QA fixes and live-blur stability (20 Oct 2026)

Backend PR + frontend PR, branch `claude/chat-qa-fixes` in both repos. Merge backend first, then frontend. No migration.

## 1. Bugs from the QA list and what was done

| # | Bug | Status | Change |
|---|---|---|---|
| 1 | Silent voice clips (2 s, 6 s) got a seller-style reply / "Plot in Sarabha Nagar" search | Fixed, **retest** | The transcriber read its own prompt word list back. Place names removed from the prompt; short transcripts made only of prompt vocabulary and no number are rejected (`isVocabularyOnly` in `voiceNoteService.js`). The user then gets "voice note samajh nahi aaya". |
| 2 | Address message got a support reply | Fixed | `src/utils/agentQuickIntent.js`: a pincode or 3+ comma-separated parts with no question goes straight to listing intake, before the AI classifier. The classifier's mid-draft bias plus the assistant's 48 h history caused it. |
| 3 | Bare "Discount?" returned the plan list | Fixed | Discount/offer/trial words route to the assistant (question), which answers from `PLANS` and `OFFERS`. |
| 4 | No reply to payment-not-activated, support number, upgrade, dashboard login, voice-note questions | Fixed | Same quick-intent file: "payment done but plan not active" raises a support request; the other topics go to the assistant. English, Hinglish and Gurmukhi/Devanagari keywords. |
| 4 | Wrong-language replies, unnatural Punjabi | Partly fixed, **retest with real model** | `detectScript()` in `replyLanguage.js`; the assistant prompt now fixes the reply script (Roman Hinglish stays Roman, Gurmukhi gets simple Gurmukhi Punjabi, English stays English). |
| 4 | Gurmukhi name + area message got only "swagat hai" | **Not fixed** | Probably the visitor signup path ignores a first message that is only a name and area. Not changed without a live model to check. |
| 5 | Hinglish discount reply opens with "Haan" | Fixed | Rule added to `plotraaKnowledge.js` (never open with Haan/Yes unless asked a yes/no question). |

## 2. Blur ("not working properly")

The exact symptom was not reproduced (no Google key / device here). Two real causes were fixed:

- **Backend:** saved blur areas were tied only to `panoId`. If Google's "nearest panorama" changed (new imagery, another pm2 process, cache expiry), the areas were silently dropped and signboards showed unblurred. Now `front_blur` also stores `heading`, `lat`, `lng`; `savedPanoView()` in `frontViewService.js` serves the saved panorama while the pin has not moved. Listings saved before this change have no heading/coords and keep the old behaviour until the dealer saves again. Moving the pin still invalidates the areas, by design.
- **Frontend (`SignBlurLayer.jsx`):** buyers saw the panorama unblurred until its first measurement; now a neutral cover shows until then. Browsers without `backdrop-filter` get a solid grey box instead of a clear one; blur strength raised to 22 px.

If blur still misbehaves, get the symptom (box misplaced, drifting on zoom, clear box on a specific phone, save failing) and device/browser. `src/utils/streetViewProjection.js` (`FOCAL_AT_ZOOM_1`) is the first place to look for drift, especially on portrait phones.

## 3. Files

Backend: `src/utils/agentQuickIntent.js` (new), `src/services/agentIntentService.js`, `src/services/voiceNoteService.js`, `src/services/assistantService.js`, `src/assistant/plotraaKnowledge.js`, `src/utils/replyLanguage.js`, `src/services/frontViewService.js`, `src/controllers/publicListingController.js`, tests `test/agentQuickIntent.test.js`, `test/frontViewService.test.js`.
Frontend: `src/components/SignBlurLayer.jsx`.

## 4. Verified / not verified

- Verified: `npm test` (102 pass), `vite build`.
- Not verified: anything against real WhatsApp, OpenAI or Google Street View. AI answer quality, Gurmukhi wording, and blur on real devices need a manual pass.

## 5. Retest checklist

1. Send a silent 2 s and 6 s voice note: expect "voice note samajh nahi aaya", no listing or search.
2. While an old draft is open, send `Main Market, Ram Nagar, Ludhiana, Punjab 141003`: expect the listing flow, not support.
3. Send: `Discount?`, `support number kya hai`, `plan upgrade karna hai`, `dashboard login kaise karu`, `payment ho gaya but plan activate nahi hua` (the last should raise a support request).
4. Hinglish questions get Roman Hinglish; English gets English; Gurmukhi gets Gurmukhi.
5. Mark a blur area before approval, approve, open the live page on a phone: area stays blurred while rotating/zooming, and no unblurred flash on load.

## 6. Deploy

Backend: `git pull && npm ci && pm2 restart all --update-env`. Then rebuild and deploy the frontend.
