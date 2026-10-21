# Handover: Plotraa bug list 21 Oct (blur + WhatsApp bot)

Branch `claude/qa-21oct` in both repos. Merge backend first, then frontend. No migration (uses the existing `listings.front_blur` jsonb).

## Blur (bugs 1-3) — decision: option A, fixed photo with blur baked in

| # | Bug | Fix |
|---|---|---|
| 1 | Blur box slides with screen size | Gone by design: buyers get one fixed photo (Street View Static, fixed panorama + heading + 70° FOV, 640x480) with the boxes blurred into the pixels on the server (`bakeBlurRects`, pixelate + blur). Dealer marks boxes on the same photo as fractions (x, y, w, h in 0..1), drawn with %, so a box covers the same pixels on any screen. |
| 2 | Box doesn't scale with zoom | Same: the blur is part of the image, zoom just scales the image. |
| 3 | Buyer can rotate/zoom the street view | Live page no longer loads Google's panorama at all, and the live API response no longer includes the panorama id. |

- `GET /public/listings/:slug/front-view.jpg` — the blurred photo (any status; live = `public, max-age=86400`, URL carries `?v=<version>`).
- `GET /public/listings/:slug/front-frame.jpg` — new, unblurred photo for the dealer editor, pre-approval only.
- `PATCH /public/listings/:slug/blur-regions` — body `{ panoId, rects: [{x,y,w,h}] }`. Old `{ regions }` (angles) still accepted and converted.
- Listings already live with old angle-based areas: converted automatically onto the photo (exact projection, `regionToFrameRect`), no re-marking needed. Worth a spot check on 2-3 of them.
- Frontend: new `FrontPhotoBlurEditor.jsx`; `SignBlurLayer.jsx` and `streetViewProjection.js` deleted; `InteractiveStreetView` lost its live/panoId mode (dealer pre-approval view only).
- Env (optional): `FRONT_PHOTO_FOV` (default 70), `FRONT_PHOTO_PITCH` (default 8). Saved boxes remember the fov/pitch they were drawn on.
- Cost: one Street View Static request per listing per 6 h per pm2 process (cached), plus the existing free metadata call.

## WhatsApp bot (bugs 4-7)

| # | Bug | Fix |
|---|---|---|
| 4 | Roman question gets Gurmukhi reply | Language line now repeated as the LAST system message (after history) and says to ignore earlier scripts; then `replyMatchesScript` checks the reply and asks the model once to rewrite if the script is wrong. Note: the danda `।` is treated as neutral (used in Gurmukhi too). |
| 5 | Discount reply too long | Short discount/offer questions (≤ 8 words, agent/visitor) skip the model: fixed 2-line reply from the live `plans` discounts, in the message's script. Anything else about discount/trial is hard-capped to 2 lines / 250 chars, cutting at a word even inside one long sentence. Buyers on a dealer's number are excluded (their "discount?" is about a property). |
| 6 | Owner told to "start listing" | Owner (visitor seller) replies are now fixed: "Details mil gayi, ek verified dealer aapse contact karega" + missing-details line + `/sell-property` link (once per chat). A visitor with an open seller lead (last 24 h) sending more details stays a seller. Prompt rule added: never tell owners about listing steps. |
| 7 | Weak payment confirmation | "Payment ho gaya, plan activate nahi hua" (any script) skips the model: support request raised + fixed "Team ko bata diya hai, wo jaldi aapse isi number pe contact karegi." Any other reply that raises support gets the confirmation line appended if the model didn't say it. |

Files: `src/utils/fixedReplies.js` (new), `src/services/assistantService.js`, `src/assistant/plotraaKnowledge.js`, `src/services/frontViewService.js`, `src/controllers/publicListingController.js`, `src/routes/public.js`; tests `test/fixedReplies.test.js` (new), `test/frontViewService.test.js`.

## Verified / not verified
- Verified: backend `npm test` 154 pass; frontend `npm test` + `vite build` pass; baked blur checked on a sample image (sign text unreadable).
- Not verified: real Google Street View photos, real WhatsApp/OpenAI. Retest list below.

## Retest
1. Pending listing: mark a box on the photo, save, tap "See what buyers get" — sign blurred. Approve; open live page on phone + desktop + pinch-zoom: blur stays on the sign, no way to rotate.
2. An already-live listing with old blur areas: open it, check the box sits on the sign.
3. Chat in Gurmukhi, then send `Discount?` — 2-line Roman reply.
4. As an unknown number: `meri kothi bechni hai Dugri mein` — "Details mil gayi…", sell-property link, no listing talk.
5. As an agent: `payment ho gaya, plan activate nahi hua` — "Team ko bata diya hai…", ticket in Admin → Support.

## Deploy
Backend: `git pull && npm ci && pm2 restart all --update-env`. Frontend: pull, `npm ci`, `npm run build`, copy `dist/` to `/var/www/plotra-frontend/`.
