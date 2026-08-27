# Plotra — Live Server QA Prompts (for Claude for Chrome)

**Purpose:** once this build is deployed, paste these prompts one at a time into Claude for Chrome (or any browser-driving agent) to verify the features changed/added in the 2026-08-26 session actually work on the real, deployed site — not just in code.

**Before you start**, fill these in and keep them handy — every prompt below assumes you'll paste the real values in place of the bracketed placeholders:

- `[SITE_URL]` — the deployed frontend URL
- `[OWNER_EMAIL]` / `[OWNER_PASSWORD]` — a tenant **owner** login (needed for plan-change/moderation steps)
- `[AGENT_EMAIL]` / `[AGENT_PASSWORD]` — a tenant **agent** login (non-owner, for permission-boundary checks), if you have one
- `[ADMIN_EMAIL]` / `[ADMIN_PASSWORD]` — a **super-admin** login
- `[WEBCHAT_URL]` — wherever `demo/plotra-web-chat.html` ended up hosted
- `[TEST_WHATSAPP_NUMBER]` — a real WhatsApp number you can send test messages from, if testing that channel

Run the prompts in order — several later ones depend on state created by earlier ones (e.g. Prompt 5 needs a listing Prompt 3 or 4 created).

---

## Prompt 1 — Satellite view: labels while editing, street view survives approval

```
Go to [SITE_URL] and log in as [OWNER_EMAIL] / [OWNER_PASSWORD].
Open the dashboard listings page and find any listing that is NOT yet
"active" (still pending approval) — if none exist, note that and skip to
the next check.

For a pending listing:
1. Open it (or its map/location view) and confirm the satellite image
   shows road names and place labels overlaid on the imagery — not a
   blank/plain satellite photo with no text on it.
2. Confirm you can drag the pin on the satellite view and a "Save"/
   "Cancel" option appears.

Then open any listing whose status IS "active" (live), via its public
/p/:slug link:
3. Confirm the satellite/pin-editing view does NOT appear on this public
   page.
4. Confirm the STREET VIEW image/panorama DOES still appear on this
   public page (this is the key check — street view should survive going
   live, satellite should not).
5. Confirm the dealer's real uploaded "Property Photos" section also
   appears further down the page.

Report exactly what you saw for each of the 5 numbered checks — pass or
fail, with a screenshot of anything that looks wrong.
```

---

## Prompt 2 — Plan tiers: public pricing page

```
Go to [SITE_URL]/pricing (no login needed).

1. List every plan shown on the page — name, price, and every feature/
   listing-limit bullet under each.
2. Confirm the prices and features are NOT hardcoded-looking placeholder
   text (e.g. "Lorem ipsum", "$X/mo") — they should be real numbers.
3. Click through any "Get Started" / "Sign Up" button under one plan and
   confirm it starts the correct signup flow for that plan (doesn't route
   everyone to the same generic form regardless of which plan was
   clicked, if the page implies plan-specific signup).

Report the full list of plans/prices/features you found, and whether
anything looked broken, missing, or inconsistent.
```

---

## Prompt 3 — Plan tiers: admin can edit/create/deactivate a plan

```
Go to [SITE_URL] and log in as [ADMIN_EMAIL] / [ADMIN_PASSWORD] (super
admin). Navigate to the admin panel's "Plans" tab.

1. Confirm every plan from the public pricing page (Prompt 2) also
   appears here, with matching price/listing-limit/features.
2. Click "Edit Plan" on any one plan, change its price by a small test
   amount (e.g. +1), save, and confirm the change is reflected
   immediately in the plan list.
3. Toggle that same plan's Active/Inactive switch off, then back on —
   confirm the toggle visibly updates each time (don't leave it off when
   you're done).
4. Click "+ Add Plan", fill in a throwaway test plan (clearly-named, e.g.
   "QA Test Plan"), save it, confirm it appears in the list.
5. Delete that same test plan via the trash-can/Delete action and confirm
   it's removed. (If deletion is blocked because a tenant is on it,
   that's expected — report that instead of forcing it through.)

Report what happened at each of the 5 steps. Revert the price change
from step 2 back to its original value before finishing.
```

---

## Prompt 4 — Plan tiers: admin can move a tenant to a different plan

```
Still logged in as [ADMIN_EMAIL] / [ADMIN_PASSWORD] on [SITE_URL], go to
the admin panel's "All Tenants" tab.

1. Confirm each tenant row shows a Plan column with a dropdown (not
   static text) listing every currently-active plan.
2. Pick any one non-critical test tenant, change its plan via the
   dropdown to a different plan, and confirm the row updates to reflect
   the new plan without a page reload.
3. Click that same tenant's row (not the dropdown) and confirm a detail
   modal opens showing owner email, join date, listing count, and a
   usage-this-month summary (views/leads/calculator uses).
4. From that detail modal, confirm there's a Suspend/Reactivate button
   and a separate Change Plan control, and that using either updates the
   tenant's state.
5. Change the tenant's plan back to what it was before you started.

Report what you saw at each step, and whether the tenant's plan actually
changed on the backend (refresh the page after step 2 and confirm the
new plan persisted, not just an optimistic UI update that silently failed).
```

---

## Prompt 5 — Web chat: plain listing creation still works

```
Go to [WEBCHAT_URL].

1. Confirm the chat widget loads and shows a greeting message and two
   clickable suggestion chips.
2. Type a plain listing description with a real address, e.g.
   "3BHK plot 250 gaj sector 45 mohali 55 lakh" (or click the matching
   suggestion chip), send it, and confirm you get back a listing preview
   with a working /p/:slug link, correct property type (Plot), price,
   and area.
3. Reply "yes" to approve it, and confirm you get a "it's live" message
   with the same link, and that opening the link shows a live public
   listing page.
4. Click the 📷 photo button, attach any test image, and confirm it
   uploads (a confirmation message with a photo count comes back) and
   that the photo appears on the public listing page from step 3.

Report the full exchange (what you typed, what came back) and whether
the resulting public listing page looks correct.
```

---

## Prompt 6 — Web chat: NEW feature — building/mall name auto-recognition + builder profile

```
Go to [WEBCHAT_URL] (a fresh page load, so you get a new chat session).

1. Type exactly: "flat available in DLF Chandigarh One" and send it.
2. Confirm the reply includes BOTH a listing preview link AND a second
   message (or part of the same message) mentioning it found or started
   researching a builder/developer profile for "DLF Chandigarh One" —
   look for a 🏗️ builder-profile note in the reply.
3. Open the listing preview link and confirm the property type shown is
   "Flat" (not Plot/Villa/Commercial, and not blank).
4. Reply "yes" to approve it.

Then start a second, separate test:
5. Reload the page for a fresh session, type exactly:
   "retail space available in Elante Mall, 60 lakh" and send it.
6. Confirm the reply again includes a listing preview AND a builder-
   profile note, and that the listing's property type comes back as
   "Commercial".
7. Reply "yes" to approve this one too.

Report the exact reply text you got back for both messages, and whether
the builder-profile confirmation actually appeared (this is a brand-new
feature — if it's silently missing, that's the most important thing to
flag).
```

---

## Prompt 7 — Dashboard: builder profile now works for Commercial too, not just Flat

```
Go to [SITE_URL] and log in as [OWNER_EMAIL] / [OWNER_PASSWORD].
Open the dashboard listings page.

1. Find (or use the ones created in Prompt 6) a listing with property
   type "Flat" — confirm its card shows a 🏗️ "Link Builder" or "Builder
   Profile" button.
2. Find a listing with property type "Commercial" — confirm it ALSO
   shows the same 🏗️ button (this is new — it used to be Flat-only).
3. Find a listing with property type "Plot" or "Villa" — confirm it does
   NOT show this button at all.
4. Click the 🏗️ button on the Flat listing from step 1. If it's already
   linked to a builder (e.g. from Prompt 6), confirm you see the company
   name and a moderation status (pending_review/published/rejected). If
   you're logged in as the tenant owner, confirm Publish/Reject buttons
   are visible and clicking "Publish" changes the status.
5. Open that listing's PUBLIC page (/p/:slug) and confirm the developer
   rating / possession record / "nearby projects" section shows up ONLY
   if you published it in step 4 — it should NOT be visible while status
   is still pending_review.

Report what you found at each step — especially step 3 (Plot/Villa must
NOT show the button) and step 5 (unpublished builder info must NOT leak
to the public page).
```

---

## Prompt 8 — WhatsApp channel: same building-name test, if you have a test number

```
Using WhatsApp on [TEST_WHATSAPP_NUMBER] (a number already registered as
a dealer/agent on the platform), send a message to the business's
WhatsApp number: "flat available in DLF Chandigarh One"

1. Confirm you get back a listing-preview message with a /p/:slug link.
2. Confirm you get a SEPARATE message (may arrive a moment after the
   preview) about a builder/developer profile being found or researched
   for "DLF Chandigarh One".
3. Reply "yes" to approve, and confirm you get an "it's live" confirmation
   with the same link.
4. Open the link and confirm the property type is "Flat" and the listing
   looks correct.

Report the exact sequence and timing of messages you received, and flag
if the builder-profile message never arrived.
```

---

## Prompt 9 — Admin flows merged this session (spot-check each)

```
Go to [SITE_URL] and log in as [ADMIN_EMAIL] / [ADMIN_PASSWORD].

1. Pending Requests tab: if there's a request with a "💬 WhatsApp signup"
   badge, click Approve and confirm you get a "Payment Link Sent"
   confirmation (not a crash, and not a credentials modal — WhatsApp
   signups have no dashboard login). Then check the "Awaiting Payment
   Confirmation" section below and confirm that request now appears
   there with a "Confirm Payment & Activate" button.
2. Log in as [OWNER_EMAIL] instead, go to Settings, and confirm there's
   a WhatsApp Number Management section separate from the personal
   "Connect Your WhatsApp Number" section — try adding a test number and
   confirm it appears in the list, then remove it again.
3. Still as owner, go to dashboard listings, and if the tenant's plan
   allows more than one WhatsApp number, confirm each listing card shows
   a "WhatsApp contact for buyers" assignment dropdown; if the plan only
   allows one number, confirm that dropdown is correctly hidden instead
   of shown-but-broken.
4. On any listing, click the ✎ Edit button, change the title to
   something clearly marked as a test, save, confirm it updates, then
   use Deactivate followed by Reactivate on that same listing and
   confirm the status badge changes both times.

Report pass/fail for each of the 4 numbered checks.
```

---

## Prompt 10 — Builder rating shows /10, and discloses when it's an AI assessment

```
Go to [SITE_URL] and log in as [OWNER_EMAIL] / [OWNER_PASSWORD].
Find a Flat or Commercial listing with a PUBLISHED builder profile (use
one created in Prompt 6/7, published via the dashboard 🏗️ button), and
open its public /p/:slug page.

1. Find the developer/builder section and confirm the rating is shown
   as "X.X /10" — NOT "/5".
2. Look for a label above the rating: it should say either "Rating"
   (if sourced from a real external ranking, with a "Source: ..." link)
   OR "Plotra's Assessment" (if synthesized).
3. If it says "Plotra's Assessment": confirm there's a short plain-
   English sentence explaining what the score is based on, AND an
   explicit disclaimer that this is an AI-generated assessment, not an
   official/certified rating. Confirm there is NOT a "Source: ..." link
   on this version (that's only for the external-citation form).
4. Confirm the cited claims below the rating (delivery history,
   leadership, financial condition, legal record) each still have a
   working "Source: ..." link — this part is unchanged regardless of
   which rating form is shown.

Report exactly what label and text you saw, and flag if the rating
shows /5 anywhere (that would mean the old scale is still live) or if
a synthesized assessment is missing its disclaimer.
```

---

## Prompt 11 — Branding and design consistency across the whole app

```
Go to [SITE_URL]. Visit, in order: the homepage (/), /login,
/request-access, /pricing, the dashboard (log in first), the admin
panel (/admin, as [ADMIN_EMAIL]), the ops panel (/dashboard/ops), and
any public listing page (/p/:slug).

For EACH page:
1. Search the visible text for "WayneState", "Wayne State", or "Wayne
   Estate" — none of these should appear anywhere. The brand name
   everywhere should read "Plotra". ("Wayne E Solutions" IS correct and
   expected on the footer/legal/team pages — that's the company name,
   not the product name, leave it alone.)
2. Note the primary accent color used for buttons/links/highlights on
   this page (should be a warm coral/orange tone) and the general dark
   color used for headers/sidebars (should be a dark ink/navy-black,
   NOT a brass/gold-and-charcoal combo, and NOT a plain bright blue).
3. Note the font used for headings vs body text.

After visiting all pages, report:
- Any page where "WayneState"/"Wayne Estate" still appears (should be
  none).
- Whether the accent color, dark color, and fonts looked THE SAME
  across all pages, or whether any page visibly clashed with the
  others (e.g. one page using gold/brass while another uses coral/
  orange, or one page in a different heading font than the rest).
Screenshot any page that looks inconsistent with the others.
```

---

## What to do with the results

For each prompt, Claude for Chrome should give you a clear pass/fail per numbered step plus screenshots of anything unexpected. If something fails:

- **Note which prompt/step number failed** and the exact text/screenshot returned.
- Check `HANDOVER.md` (same repos, same commit) for the relevant feature's description and required env vars — most "it doesn't work at all" failures trace back to a missing/misconfigured env var (especially `WEB_CHAT_TENANT_ID`/`WEB_CHAT_AGENT_USER_ID`, `OPENAI_API_KEY`, or a worker process not actually running — see HANDOVER.md §4, item 5).
- Anything else, bring the failing prompt + result back and it can be debugged directly.
