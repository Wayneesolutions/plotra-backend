# Plotra — Handover Document

**Last updated:** 2026-08-26 (evening)
**Repos:** `Wayneesolutions/plotra-frontend` (React/Vite) + `Wayneesolutions/plotra-backend` (Node/Express)

This doc has two jobs: tell you exactly what's live on `main` right now vs. what's still sitting in a PR waiting on you, and give whoever deploys this the operational details (env vars, infra, smoke test).

**Everything from this point forward was written/verified by Claude Code across two work sessions (2026-08-25 evening → 2026-08-26 evening). Your team (santwayne) has also been pushing directly to both `main`s throughout the same window — see §2, this isn't a closed system only one party touched.**

---

## 1. What's actually LIVE on `main` right now

Confirmed straight from `git log`, not from memory — if you want to re-verify, `git log --oneline -20` on each repo's `main`.

### plotra-frontend `main`
- Satellite view shows road/place labels while a dealer is correcting a pin; **street view** (not satellite) now stays visible to buyers after a listing goes live, alongside real photos.
- Builder/developer-profile UI (Link Builder button, public developer section) extended from Flat-only to Flat **and** Commercial.
- 5 dealer/admin PRs merged: WhatsApp number management, re-pointed multi-agent gate, WhatsApp signup admin approval, plan-assignment dropdown, and a stale PR (Lead Inbox/Property Edit/Tenant drill-down/Maps fix) that needed manual conflict resolution.
- Cleanup: removed a stray `dist.zip`, an orphaned unused component, and a stale duplicate of the web chat widget.
- `HANDOVER.md` and `QA_TESTING_PROMPTS.md` added (this file, and a set of ready-to-paste live-site test prompts for Claude for Chrome).
- **Your team's own commits on top of all that** (most recent first): full admin sidebar navigation, sidebar descriptions + back-to-dashboard link, branding/Leads/Analytics nav + plan-gated WhatsApp numbers, billing modal crash fix, Settings/Admin nav buttons, login autofill visibility fix, access-request API URL + field-name fixes, Plotra branding fix in dashboard nav.

### plotra-backend `main`
- Chat-based listing creation (WhatsApp + web chat) now recognizes "Flat" as a property type (it only knew Plot/Villa/Commercial before) and a named building/mall alone is enough to create a listing — no separate address required.
- That auto-creates a builder/developer profile link inline, right in the conversation, reusing an existing profile or kicking off AI research on a new one — extended to Commercial listings too, not just Flat.
- **Nearby-landmark data fixed** (schools/hospitals/markets/transit): results were being mislabeled (anything Google didn't tag cleanly fell back to "market") and weren't actually the nearest ones (no distance ranking). Both fixed — see §3, this needs a backfill for already-live listings.
- Cleanup: removed the same stray `dist.zip` that had ended up in this repo too.
- **Your team's own commit on top of that:** a BullMQ dedup fix (a previously-failed extraction job with a static jobId was permanently blocking new ones for the same draft).

---

## 2. What's still an open PR — needs your review before it does anything

Nothing below this line is live yet. Numbers/links are on GitHub.

| Repo | PR | What it does | Status / what to do |
|---|---|---|---|
| backend | [**#20**](https://github.com/Wayneesolutions/plotra-backend/pull/20) | Builder rating widened 0-5 → 0-10; can now be a synthesized "ability to deliver" AI assessment (with a visible basis, never presented as an official rating) when no real published rating exists for that developer | Ready to review/merge. Includes a new migration — run `npm run migrate` after merging. |
| frontend | [**#10**](https://github.com/Wayneesolutions/plotra-frontend/pull/10) | Companion to #20 — shows the rating as `/10`, discloses when it's a synthesized assessment instead of an external citation | Merge together with backend #20 (order doesn't strictly matter, but the rating won't display correctly until both are in) |
| backend | [**#21**](https://github.com/Wayneesolutions/plotra-backend/pull/21) | One-off script to re-queue landmark extraction for listings whose data is still wrong from before the fix landed on `main` | Standalone, no dependency on #20. Merge any time, then **run it** — see §3. |

### A PR you should close, not merge

**backend [#11](https://github.com/Wayneesolutions/plotra-backend/pull/11)** ("Don't default unmatched landmark places to 'market' — drop them") — this is an **older, smaller fix for the exact same bug** already fixed and merged to `main` directly (the fix described in §1). #11 only patches the "defaults to market" half of the bug; the merged fix on `main` also fixes "wasn't actually nearest" and rewrote the surrounding code, so #11's diff no longer applies cleanly and would just reintroduce a worse version of logic that's already gone. **Recommend closing #11 as superseded**, not merging it.

### Pre-existing PR backlog — not part of this work, not reviewed by Claude, listed for visibility only

These were already open before either session touched anything, all still based on an older `main` (pre-dating the landmark fix and builder-profile chat work above), all backend, all look like plan-tier/billing work:

- [#19](https://github.com/Wayneesolutions/plotra-backend/pull/19) — Deactivate starter/growth/unlimited plans for new signups
- [#18](https://github.com/Wayneesolutions/plotra-backend/pull/18) — WhatsApp self-serve onboarding for Tier 1
- [#17](https://github.com/Wayneesolutions/plotra-backend/pull/17) — Re-point per-listing agent-assignment gate at max_whatsapp_numbers
- [#16](https://github.com/Wayneesolutions/plotra-backend/pull/16) — Calling-access plan gate + Tier 3 minute-overage tracking
- [#15](https://github.com/Wayneesolutions/plotra-backend/pull/15) — Enforce plans.dashboard_access at login and on every dashboard route
- [#14](https://github.com/Wayneesolutions/plotra-backend/pull/14) — Multiple WhatsApp numbers per tenant, repoint inbound routing
- [#13](https://github.com/Wayneesolutions/plotra-backend/pull/13) — Calendar-month-scoped listing limit
- [#12](https://github.com/Wayneesolutions/plotra-backend/pull/12) — Plan tier-gate columns (dashboard_access, calling_access, max_whatsapp_numbers, monthly_listing_limit)

I did not read, test, or verify any of these — they need your own team's review. Flagging them here so nobody assumes this handover doc covers everything outstanding; it only covers what Claude Code touched.

---

## 3. Landmark fix — you must run a backfill for it to show up on existing listings

The fix on `main` only affects **new** landmark lookups. Every listing that already had landmarks computed before the fix landed — including whatever page prompted this fix (the flats page with wrong schools/hospitals/markets) — keeps the old wrong data until something re-triggers extraction for it. That's what PR #21's script is for:

```bash
# 1. See what would be affected, without touching anything
node scripts/backfillLandmarks.js --dry-run

# 2. Small scoped test — pick one tenant, a handful of listings
node scripts/backfillLandmarks.js --tenant <id> --limit 5
# then check that tenant's listings on the live site look right

# 3. Full run (active listings by default; add --all-statuses for pending/inactive too)
node scripts/backfillLandmarks.js
```

It only enqueues BullMQ jobs — it doesn't call Google itself, so it's safe to run against however many listings exist. The actual Google Places lookups happen afterward, at whatever pace `landmarkWorker.js`'s own processing runs at (the `worker:landmark` process needs to be running for anything to actually happen — see §5, step 5).

---

## 4. Architecture quick reference

```
plotra-frontend (Vite/React SPA)
  └─ built as static assets, served from S3+CloudFront, Vercel, or similar
  └─ talks to plotra-backend over VITE_API_BASE_URL

plotra-backend (Node/Express API)
  ├─ src/server.js               — the API process (npm start)
  ├─ src/workers/*.js             — 8 SEPARATE long-running processes, not part of the API process
  ├─ PostgreSQL                   — primary datastore (Knex migrations)
  ├─ Redis                        — BullMQ job queues (geo-enrichment, WhatsApp send, AI extraction, builder research, etc.)
  ├─ S3                           — photo/media storage
  └─ External APIs: Google Maps, OpenAI (gpt-4o-mini + web-search Responses API),
     a WhatsApp BSP (Meta Cloud API or similar), Stripe, SMTP, WayneRing (voice calling)
```

The backend is **not** a single process. In production you need the API server *and* all 8 workers running continuously (see `package.json`'s `worker:*` scripts, or the combined `npm run workers`). If you only deploy `src/server.js`, WhatsApp messages will be logged but never actually processed — nothing will geocode, nothing will get a reply, no builder research will run, and the landmark backfill in §3 will just sit queued forever.

The **web chat widget** dealers actually use is `plotra-backend/demo/plotra-web-chat.html` — a static HTML file, not part of the React app. It needs to be hosted somewhere reachable and its `window.PLOTRA_CONFIG.API_ENDPOINT` / `PHOTO_ENDPOINT` pointed at wherever the backend actually ends up living.

---

## 5. Environment variables required

### Frontend (`.env` at build time — Vite only exposes `VITE_`-prefixed vars)

| Var | Required? | Notes |
|---|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | **Yes** | Satellite/street-view map, PlotBoundaryTracer |
| `VITE_API_BASE_URL` | Only if frontend/backend are on different hosts | Leave blank if same origin |

### Backend (`.env` on the server / worker processes)

**Hard requirements:**

| Var | Why |
|---|---|
| `JWT_SECRET` | Server **refuses to start** without it — generate with `openssl rand -hex 32` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | PostgreSQL connection |
| `REDIS_HOST` / `REDIS_PORT` | BullMQ — every async flow depends on this |
| `GOOGLE_MAPS_API_KEY` | Geocoding, satellite/street-view, landmark search |
| `OPENAI_API_KEY` | Chat extraction (gpt-4o-mini) AND builder due-diligence research (web-search Responses API) |
| `BSP_GATEWAY_URL` / `BSP_API_KEY` | WhatsApp send/receive |
| `PUBLIC_APP_URL` | Used to build every `/p/:slug` listing link |
| `WEB_CHAT_TENANT_ID` / `WEB_CHAT_AGENT_USER_ID` | **Required in production** — the web chat endpoint refuses to process messages without both |

**Feature-specific (leave blank to soft-disable just that feature):**

| Var | Feature |
|---|---|
| `WHATSAPP_WEBHOOK_SECRET` | Verifies inbound WhatsApp webhook signatures |
| `WHATSAPP_SHARED_NUMBER` | Fallback wa.me number |
| `CORS_ORIGIN` | Comma-separated allowed frontend origins |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | Onboarding/receipt emails |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Billing |
| `WAYNERING_*` (7 vars) | AI voice-calling integration |

Full details for every one of these live in `plotra-backend/.env.example` — copy it, don't retype it.

---

## 6. Deploy checklist (AWS)

1. **Database**: provision Postgres, run `npm run migrate` (never edit old migration files). If merging PR #20, its migration adds `rating_basis`/`rating_is_ai_assessment` to `builder_profiles` and widens `overall_rating` — make sure it's actually run, not just merged.
2. **Redis**: provision (ElastiCache or similar) — shared by the API process and all 8 workers.
3. **S3 bucket**: for photo/media uploads (`s3Service.js`).
4. **Backend API**: deploy `src/server.js` with every env var from §5.
5. **Backend workers**: deploy all 8 as **separate long-running processes** — `worker:geo`, `worker:landmark`, `worker:vocallm`, `worker:whatsapp`, `worker:agentIntake`, `worker:localIntel`, `worker:builderDD`, `worker:wayneRingSync`. Don't run `npm run workers` (concurrently, one process for all 8) in production — no per-worker restart isolation.
6. **Web chat widget**: host `plotra-backend/demo/plotra-web-chat.html` somewhere reachable and update its config to the real backend URL.
7. **Frontend**: `npm run build` → static assets. Set `VITE_GOOGLE_MAPS_API_KEY` (and `VITE_API_BASE_URL` if split-host) at build time.
8. **WhatsApp BSP webhook**: point at `POST /api/v1/webhooks/whatsapp` on the deployed backend.
9. **Stripe webhook** (if billing is live): point at `POST /api/v1/webhooks/stripe`.
10. **Run the landmark backfill** (§3) once the landmark fix is live — otherwise the reported bug will still look unfixed even though the code is deployed.

---

## 7. Smoke test after deploy

- [ ] View an already-live listing — satellite doesn't appear, street view does, real photos show.
- [ ] View a listing's nearby-landmarks section — schools/hospitals/markets should now be genuinely nearby, correctly categorized. (Won't be true for pre-existing listings until §3's backfill runs.)
- [ ] Web chat: type "flat available in [any real building name]" — confirm it creates a Flat listing and a builder-profile note comes back in the same reply.
- [ ] If PR #20/#10 are merged: open a Flat/Commercial listing with a linked, published builder profile — rating shows as `/10`; if it's a synthesized assessment, the basis text and disclaimer show instead of a source link.
- [ ] Dashboard → Flat or Commercial listing → 🏗️ Link Builder button appears; Plot/Villa does not.
- [ ] Full checklist from the previous handover pass is in `QA_TESTING_PROMPTS.md` in this same repo — 9 ready-to-paste prompts for Claude for Chrome covering everything from both sessions.

---

## 8. Notes on merged PR #3 (frontend, if anyone asks)

One of the merged PRs (`fix/lead-inbox-and-maps-bug`) was 6 weeks old and had drifted out of sync with `main`. Two of its four fixes turned out to be moot/redundant by the time it merged: its Maps bug fix was already independently fixed by a full rewrite of `PlotBoundaryTracer.jsx` already on `main`, and its "Lead Inbox" modal duplicated an already-shipped, better-integrated Leads page. Property Edit modal and Tenant drill-down (the other two fixes) merged in as originally written.
