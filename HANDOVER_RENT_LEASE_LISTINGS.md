# Handover: Sale / Rent / Lease listings (4 Nov 2026)

Until now every Plotraa listing was implicitly *for sale*. This adds rental
(flats, kothis, floors, rooms/PG, shops, offices) and lease (commercial /
long-term) listings end to end: dealer upload, search, AI calls, public page,
dashboard, 30-day check and owner leads.

## Deploy

1. Merge this PR and the matching plotra-frontend PR.
2. `npm run migrate` → runs `20261104_01_listing_type_rent_lease.js`
   (additive; every existing listing becomes `listing_type = 'sale'`).
3. Restart all pm2 processes (API + workers). Rebuild the frontend.

No new env vars. No new Meta templates (the Sell/Rent/Lease buttons are
session-window interactive buttons, same as the Still Available / Sold check).

## Dealer flow on WhatsApp (and web chat)

1. **First question for every new listing: "Sell, Rent or Lease?"** sent
   alone with three buttons (`ltype:sale|rent|lease`). The dealer can also
   reply `1 / 2 / 3`, `rent`, `kiraye pe`, `lease`, or say it in the property
   message itself ("2bhk flat for rent ..."), which skips the question.
2. Next questions follow the answer:
   - **Sale**: title, address, type (price optional, as before).
   - **Rent**: + monthly rent (required); type question offers Flat / Kothi /
     Independent Floor / Room-PG / Shop / Office.
   - **Lease**: + monthly lease rent (required); type question offers Shop /
     Showroom / SCO / Office / Godown / Factory / Land.
3. **Rent/lease only:** one optional details question, asked once (deposit,
   furnishing, family/bachelors/company, available from; or lease term,
   lock-in, yearly increase %). Any reply or `skip` moves on.
4. Location pin and preview exactly as before. The preview now starts with
   `🏷️ For Rent · ₹18,000/month + ₹36,000 deposit`.

A bare `1/2/3` while this question is open is routed straight to intake in
`webhookController.js`, **before** the plan-menu number handler, so it can't be
taken as a plan choice.

## Data

`listings`: `listing_type` (sale|rent|lease, CHECK), `monthly_rent`,
`security_deposit`, `maintenance_charges`, `furnishing`, `preferred_tenant`,
`available_from`, `lease_term`, `lock_in`, `rent_escalation_percent`,
`property_subtype`. `price` still means the sale price only.
`property_type` is unchanged (Plot / Flat / Villa / Commercial) so every
existing filter keeps working; `property_subtype` says what it really is.

`agent_listing_drafts`: `listing_type`, `details_requested_at`.
`seller_leads`: `listing_type`.

All shared logic lives in `src/utils/listingTypes.js` (parsing the answer,
required fields, questions, normalising amounts, price line).

## Search / buyers

- WhatsApp buyer flow now starts with **Buy / Rent / Lease**; rent asks the
  monthly rent budget ("15k", "25000"). "flat kiraye pe chahiye" as a first
  message skips the role menu and the purpose question.
- Free-text search: the model returns buy/rent/lease; if not said, a budget
  under ₹2 lakh is read as monthly rent. Rent budgets filter `monthly_rent`.
- Mixed results are labelled `[For Rent]` / `[For Sale]`; all-sale results
  look exactly as before.
- AI call enquiries with intent `rent` only get rental listings, `buy` only
  sale listings.
- Owners saying "kiraye pe dena hai" / "rent out my shop" get the owner form
  link opened on "Rent out" (`/sell-property?type=rent`).

## Other changes

- 30-day check asks "still available for rent?" with a **Rented Out** /
  **Leased Out** button (same `sold:` id, so same handler; status stays
  `sold`).
- Public page API returns the rent fields + `price_display`; OG preview
  says "For Rent: ₹18,000/month".
- Dashboard API: create/update accept the rent fields; list supports
  `?listing_type=` and min/max price filter monthly rent for rentals.
- Admin listings API returns/filters `listing_type`.
- Builder "Compare Nearby Projects" compares rentals with rentals by rent.
- Assistant knowledge + intent prompt updated ("flat kiraye pe chadh gaya" =
  mark sold).

## Not in this PR

- Duplicate-address check and Excel bulk upload were planned earlier but are
  not built in the codebase yet; when they are, include `listing_type` (the
  same property can be listed for sale and for rent).
- Rented-out listings use status `sold` (no separate `rented` status).

## Tests

`test/listingTypes.test.js` (new) + updated `test/visitorFlow.test.js`.
`npm test`: 221 pass.
