# Handover: Agent profile + Seller leads

Two features, two PRs, one staging branch per repo. **Nothing has been merged into `main` yet.**

| Repo | PR | Staging branch (merged, verified) | Feature branch |
|---|---|---|---|
| plotra-backend | [#56](https://github.com/Wayneesolutions/plotra-backend/pull/56) | `staging` | `claude/plotra-agent-profile-selling-a2gjov` |
| plotra-frontend | [#40](https://github.com/Wayneesolutions/plotra-frontend/pull/40) | `staging` | `claude/plotra-agent-profile-selling-a2gjov` |

Both feature branches merge cleanly into `main` (checked with `git merge-tree`).

## What was built

### 1. Agent profile on the public property page
- Shown right after the title/address block on the property page. Rating (stars), years of experience, RERA certified / not. **No agent name is exposed.**
- Data lives on the **tenant (dealer)**, not the individual agent: `tenants.agent_rating` (decimal 2,1; DB check 0-5), `tenants.agent_experience_years`, `tenants.rera_certified` (default false).
- `GET /api/v1/public/listings/:slug` returns `agentProfile: { rating, experienceYears, reraCertified }`.
- Rating is set by super-admin only (no reviews system yet): `PATCH /api/v1/admin/tenants/:id/agent-profile` with `{ agent_rating, agent_experience_years, rera_certified }` (null clears rating/experience). Also editable in the admin Tenant Detail modal ("Public agent profile"). `GET /admin/tenants/:id` now returns `agentRating`, `agentExperienceYears`, `reraCertified`.
- The card is hidden when a tenant has no rating, no experience and is not RERA certified.

### 2. Sell-your-property leads
- Customer site: new page `/sell-property` (linked in nav + footer, SEO entry added). Posts to `POST /api/v1/public/sell-property` (rate limited by `publicWriteLimiter`; requires name + valid phone; same phone within 24h while still `new` is de-duplicated).
- New table `seller_leads` (status `new | assigned | closed`). No RLS, same as `call_enquiries`: written by the public route, read only by super-admin routes.
- Super-admin (all under `/api/v1/admin`, behind authGuard + adminGuard + serviceContext):
  - `GET /seller-leads?status=&limit=&offset=` (returns `byStatus` counts)
  - `PATCH /seller-leads/:id/assign` `{ tenant_id, admin_notes? }`: forwards to any **active** dealer and inserts a normal `leads` row for that dealer (`source = 'seller_lead'`) so it appears in their existing leads inbox. Re-assigning creates another lead row for the new dealer; the previous dealer's row is left as-is.
  - `PATCH /seller-leads/:id` `{ status: 'new'|'closed', admin_notes? }`
- Admin UI: new "Seller Leads" tab (filter, dealer dropdown + Send, Close/Reopen).

## Files changed

**Backend**: `migrations/20261015_01_agent_profile_and_seller_leads.js`, `src/controllers/sellerLeadController.js` (new), `src/controllers/adminController.js`, `src/controllers/publicListingController.js`, `src/routes/admin.js`, `src/routes/public.js`.

**Frontend**: `src/components/AgentProfileCard.jsx`, `src/components/AdminSellerLeads.jsx`, `src/pages/SellPropertyPage.tsx` (all new); `PropertyView.jsx`, `TenantDetailModal.jsx`, `AdminPanel.jsx`, `App.jsx`, `lib/plotra-api.ts`, `seo/pages.js`, `plotra/site-nav.tsx`, `plotra/site-footer.tsx`.

## Merge / deploy steps
1. Review and merge **backend #56 first**, then **frontend #40** (the frontend calls the new endpoints).
2. Run `npm run migrate` on the target DB. The new migration is additive (3 columns + 1 table); `down` reverses it.
3. Deploy backend, then frontend. No new env vars.
4. Smoke test (below).

## What was verified
- Migration `up` on real Postgres 16, including the rating CHECK constraint (rejects 6).
- Controller calls against that DB: submit (201), duplicate submit (200, no new row), invalid submit (400), admin list, assign (creates the dealer `leads` row with `source = 'seller_lead'`), agent-profile update (valid 200, rating 9 -> 400).
- Frontend `vite build` passes on both the feature branch and staging.

## NOT verified (please check)
- UI not viewed in a browser (card layout, `/sell-property` form, admin tab).
- Admin routes not called over HTTP with real super-admin tokens; public endpoint not hit through the real router/rate limiter.
- **Pre-existing issue, unrelated to this work:** on a brand-new empty database, `npx knex migrate:latest` fails at `20260825_04_tier_plans.js` (inserts into `plans.max_whatsapp_numbers`, a column that doesn't exist yet at that point). Existing databases are unaffected; a fresh environment can't be built from the migrations as they stand. My migration was tested in isolation against only the tables it needs (`tenants`, `users`, `leads`).

## Smoke test after deploy
1. As super-admin, open All Tenants -> a tenant -> set rating 4.5, 8 years, RERA on -> Save profile.
2. Open an active listing's public page: the "Real estate agent" card shows 4.5 stars, 8 years, "RERA certified", no name.
3. Visit `/sell-property`, submit the form: success screen.
4. Admin -> Seller Leads: the submission appears under New. Pick a dealer -> Send. It moves to Assigned and shows in that dealer's leads inbox.

## Known limitations / follow-ups
- Profile is per dealer, not per assigned agent. Per-agent would need columns on `users` and a change to the public listing query.
- Rating is manual; no customer review flow.
- No WhatsApp/email notification to the dealer when a seller lead is assigned (it only appears in their leads inbox).
- Seller leads have no tenant/city targeting; the admin picks the dealer manually.
