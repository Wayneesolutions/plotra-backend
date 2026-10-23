# 23 Oct QA fixes: handover

## Critical
1. **Trial over, listing still made.** `trialService.canAddNewListing()` / `listingAllowed()` now check the trial date (`trial_ends_at` via `billingState()`) as well as the `can_add_listing` flag. They are used in `webhookController` (every dealer message), at the top of `handleAgentIntakeMessage`, and for **publish ("yes")**: a listing that is not live yet (`awaiting_approval` / `pending`) can't be published once the trial is over. `dealerIsActive()` reads the date too (dashboard create, lead forwarding). Existing live listings and their corrections keep working.
2. **Builder rating made public without approval.** Switched off by default:
   - `GET /public/listings/:slug/builder-profile` returns 404 unless `BUILDER_PROFILE_PUBLIC=on`.
   - `autoPublishIfReady()` does nothing unless `BUILDER_AUTO_PUBLISH=on`.
   - Before turning it back on: fix the two "Orbit" profiles (company matching), and only publish after a human approves.
3. **Old "1 Buyer 2 Dealer" menu vs "2 = Owner".** The menu on main is 1 Buyer / 2 Dealer (PR #70). The AI prompt now shows the same menu with the same numbers, never an Owner option, and reads "2" as Dealer. A visitor whose saved state is from the old 3-option menu and replies a bare "2" is shown the current menu again instead of getting a guessed role (`menu_v` in the flow state).
4. **Cash removed** from the plan-selected reply, the QR/receipt line, the dealer help menu, the AI knowledge ("pay cash"), the old signup "reply CASH" path and the reminder texts. With an online link, no receipt line is shown. QR payers still send a screenshot ("payment").
5. **Admin Payments, Next Due.** A dealer who never paid is due on `trial_ends_at` (`next_due_kind: 'trial_end'`, shown as "Trial ends · Xd left"). `can_add_listing` in that list is the real state (flag + trial date).
6. **Razorpay name.** Payment links send `options.checkout.name = "Plotraa"` (override with `RAZORPAY_CHECKOUT_NAME`). Links made before 24 Oct (IST) are not reused, so nobody gets an old "Wayne E Solutions" link (`RAZORPAY_BRANDED_SINCE`).

## Buyer
- Budget is a max in the SQL query (+10%), so over-budget listings never take result slots. The free-text search also reads the budget now. "50L", "50 lac tak", "0.5 cr" are understood.
- "Price on request" listings come after the priced ones, under their own heading.
- Area line: Locality Master name first; the geocoded area only when it agrees with the title; otherwise the place in the title. No more "Plot in Dasmesh Nagar · Industrial Area-B".
- Size: only clean units are shown ("250 sq yd", "10 marla"); unreadable text like "100 PLYORD SQ" is hidden.
- Prices show as "₹50 lakh" / "₹2.7 crore".
- Buyer can pick several types: "1, 2, 3", "1 aur 3", "plot ya flat".

## Sell intent
- "want to sell / bechna hai / vechna hai / sell karni hai" (any role, any step, on the Plotraa number or a dealer's number) gets the `/sell-property` link (`sell_link` text). No search runs. Registered dealers are not affected (their "bechni hai" is still a listing).
- The AI's "are you a dealer?" question no longer says "property owner".

## Env (all optional)
`BUILDER_PROFILE_PUBLIC`, `BUILDER_AUTO_PUBLISH`, `RAZORPAY_CHECKOUT_NAME`, `RAZORPAY_BRANDED_SINCE`.

Tests: `npm test`, 205 pass (new: `test/qa23Oct.test.js`, extra cases in `test/visitorFlow.test.js`).
