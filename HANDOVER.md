# Plotra — Handover Document

**Last updated:** 2026-08-26 (late evening)
**Repos:** `Wayneesolutions/plotra-frontend` (React/Vite) + `Wayneesolutions/plotra-backend` (Node/Express)

This doc has two jobs: tell you exactly what's live on `main` right now vs. what's still sitting in a PR waiting on you, and give whoever deploys this the operational details (env vars, infra, smoke test).

**This has been written/updated across multiple Claude Code sessions today (2026-08-25 evening → 2026-08-26 late evening). Your team (santwayne) has also been pushing directly to both `main`s throughout the same window, including a full migration of the public-facing pages to a new design system — see §2.**

---

## 1. What's actually LIVE on `main` right now

Confirmed straight from `git log`, not from memory.

### plotra-frontend `main`
- Satellite view shows road/place labels while a dealer is correcting a pin; **street view** stays visible to buyers after a listing goes live, alongside real photos (satellite drops away — it's a pin-correction tool only).
- Builder/developer-profile UI (Link Builder button, public developer section) extended from Flat-only to Flat **and** Commercial.
- 5 dealer/admin PRs merged: WhatsApp number management, re-pointed multi-agent gate, WhatsApp signup admin approval, plan-assignment dropdown, and a stale PR (Lead Inbox/Property Edit/Tenant drill-down/Maps fix) needing manual conflict resolution.
- Cleanup: removed a stray `dist.zip`, an orphaned unused component, and a stale duplicate of the web chat widget.
- **Your team's own work, layered on top**, most significantly: a full migration of the public marketing/auth pages (`/`, `/login`, `/request-access`, `/forgot-password`, `/pricing`, `/how-it-works`, `/legal`, `/team`) to **brand-new TypeScript/Tailwind pages** in `src/pages/*.tsx`, using a new design system (`src/styles.css` — "Midnight Ink / Deep Indigo / Electric Coral / Digital Mint / Soft Lavender", Space Grotesk + Plus Jakarta Sans fonts). `App.jsx` already routes to these — the OLD versions of those same pages (`src/components/LandingPage.jsx`, `Login.jsx`, `RequestAccess.jsx`, `ForgotPassword.jsx`, `Pricing.jsx`) are now **dead code**, unreachable, still present in the repo but not routed to. Also: full admin sidebar navigation, billing modal fix, login autofill fix, access-request API fixes.

### plotra-backend `main`
- Chat-based listing creation (WhatsApp + web chat) recognizes "Flat" as a property type and a named building/mall alone is enough to create a listing — no separate address required. Auto-creates a builder/developer profile link inline. Extended to Commercial listings too.
- **Nearby-landmark data fixed** (schools/hospitals/markets/transit): was mislabeling results and wasn't actually returning the nearest ones. Fixed — **needs a backfill for already-live listings, see §3**.
- Cleanup: removed a stray `dist.zip`.
- **Your team's commit on top:** a BullMQ dedup fix (a previously-failed extraction job with a static jobId was permanently blocking new ones for the same draft).

---

## 2. Design system — now unified, pending your review

Before today, **three unrelated design systems** coexisted in the frontend:
1. A legacy blue + Inter system across most of the actual dashboard/admin app.
2. A charcoal/brass/teal/rust system (the old "WayneState Pro"/Lovable mockup identity) in `OpsPanel.jsx` and parts of `AdminPanel.jsx`.
3. The new Tailwind system your team built today for the 8 new `src/pages/*.tsx` pages — completely disconnected from everything else.

Per your direction, **every remaining old-system component has been recolored/refonted onto system #3's tokens** (`ink`, `coral`, `mint`, `indigo-deep`, `destructive`, `cream`; Space Grotesk + Plus Jakarta Sans) — 19 files, same layouts/structure, just new colors and fonts. See §4 for the PR. Also fixed: 7 files still said "WayneState Pro" instead of "Plotra" (your team had already fixed the dashboard/admin sidebar; this caught the rest — public listing page, reset-password, and some now-dead pages).

**Not visually verified** — this sandbox can't load your deployed site or run a browser preview. Please actually look at a handful of pages before merging.

---

## 3. Landmark fix — needs a backfill for existing listings

The fix on `main` only affects **new** landmark lookups. Every listing that already had landmarks computed before it landed — including whatever prompted the fix (wrong schools/hospitals/markets on a live flats page) — keeps the old wrong data until re-triggered. Script for that is in an open PR (see §4):

```bash
node scripts/backfillLandmarks.js --dry-run                    # 1. preview
node scripts/backfillLandmarks.js --tenant <id> --limit 5      # 2. small scoped test
node scripts/backfillLandmarks.js                              # 3. full run (active listings by default)
```

Only enqueues BullMQ jobs — doesn't call Google itself, safe to run at any scale. The `worker:landmark` process needs to actually be running for anything to happen.

---

## 4. Open PRs — full ledger, nothing below this line is live yet

### plotra-frontend

| PR | Base | What it does | Notes |
|---|---|---|---|
| [**#10**](https://github.com/Wayneesolutions/plotra-frontend/pull/10) | `main` | Builder rating shown as `/10`, discloses synthesized AI assessments | Pairs with backend #20 — merge together |
| [**#12**](https://github.com/Wayneesolutions/plotra-frontend/pull/12) | `main` | Fixes remaining "WayneState Pro" → "Plotra" branding (7 files) | Merge before #13 |
| [**#13**](https://github.com/Wayneesolutions/plotra-frontend/pull/13) | `fix/waynestate-pro-branding-to-plotra` (i.e. **stacked on #12**) | Unifies color palette + fonts across all 19 still-routed old-system components onto the new design system | Merge #12 first, or GitHub's diff view will show both PRs' changes combined until then |

### plotra-backend

| PR | Base | What it does | Notes |
|---|---|---|---|
| [**#20**](https://github.com/Wayneesolutions/plotra-backend/pull/20) | `main` | Builder rating 0-5 → 0-10, synthesized AI assessment when no external rating exists | Includes a migration — run `npm run migrate` after merging |
| [**#21**](https://github.com/Wayneesolutions/plotra-backend/pull/21) | `main` | The landmark backfill script (§3) | Standalone, no dependency on #20 |

### Close, don't merge

**backend [#11](https://github.com/Wayneesolutions/plotra-backend/pull/11)** — an older, smaller fix for the exact same landmark bug already fixed on `main`. Its diff no longer applies cleanly against the current `landmarkWorker.js` and would reintroduce a worse version. Recommend closing as superseded.

### Pre-existing backlog — not part of any of this work, not reviewed by Claude

All backend, all still based on an older `main` (pre-dating the landmark fix and builder-profile chat work), all look like plan-tier/billing work — listed for visibility only, needs your team's own review:

- [#19](https://github.com/Wayneesolutions/plotra-backend/pull/19) Deactivate legacy plans for new signups
- [#18](https://github.com/Wayneesolutions/plotra-backend/pull/18) WhatsApp self-serve onboarding (Tier 1)
- [#17](https://github.com/Wayneesolutions/plotra-backend/pull/17) Re-point agent-assignment gate at max_whatsapp_numbers
- [#16](https://github.com/Wayneesolutions/plotra-backend/pull/16) Calling-access plan gate + Tier 3 minute-overage tracking
- [#15](https://github.com/Wayneesolutions/plotra-backend/pull/15) Enforce plans.dashboard_access at login/routes
- [#14](https://github.com/Wayneesolutions/plotra-backend/pull/14) Multiple WhatsApp numbers per tenant
- [#13](https://github.com/Wayneesolutions/plotra-backend/pull/13) Calendar-month-scoped listing limit
- [#12](https://github.com/Wayneesolutions/plotra-backend/pull/12) Plan tier-gate columns

**Suggested merge order overall:** #12 (frontend branding) → #13 (frontend design system) → #10 + #20 (builder rating, paired) → #21 (landmark backfill, run it after #21 merges and the landmark fix is deployed) → close #11 → then your team's own backlog (#12-19 on backend) on their own schedule.

---

## 5. Architecture quick reference

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

The backend is **not** a single process — you need the API server *and* all 8 workers running continuously (`package.json`'s `worker:*` scripts). Deploying only `src/server.js` means WhatsApp messages get logged but never processed, nothing geocodes, no builder research runs, and the landmark backfill (§3) just sits queued forever.

The **web chat widget** dealers actually use is `plotra-backend/demo/plotra-web-chat.html` — a static HTML file, not part of the React app. Needs to be hosted somewhere reachable, with `window.PLOTRA_CONFIG.API_ENDPOINT` / `PHOTO_ENDPOINT` pointed at the real backend URL.

---

## 6. Environment variables required

### Frontend (`.env` at build time — Vite only exposes `VITE_`-prefixed vars)

| Var | Required? | Notes |
|---|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | **Yes** | Satellite/street-view map, PlotBoundaryTracer |
| `VITE_API_BASE_URL` | Only if frontend/backend are on different hosts | Leave blank if same origin |

### Backend (`.env` on the server / worker processes)

**Hard requirements:**

| Var | Why |
|---|---|
| `JWT_SECRET` | Server **refuses to start** without it — `openssl rand -hex 32` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | PostgreSQL connection |
| `REDIS_HOST` / `REDIS_PORT` | BullMQ — every async flow depends on this |
| `GOOGLE_MAPS_API_KEY` | Geocoding, satellite/street-view, landmark search |
| `OPENAI_API_KEY` | Chat extraction (gpt-4o-mini) AND builder due-diligence research |
| `BSP_GATEWAY_URL` / `BSP_API_KEY` | WhatsApp send/receive |
| `PUBLIC_APP_URL` | Used to build every `/p/:slug` listing link |
| `WEB_CHAT_TENANT_ID` / `WEB_CHAT_AGENT_USER_ID` | **Required in production** — web chat refuses to process messages without both |

**Feature-specific (leave blank to soft-disable just that feature):**

| Var | Feature |
|---|---|
| `WHATSAPP_WEBHOOK_SECRET` | Verifies inbound WhatsApp webhook signatures |
| `WHATSAPP_SHARED_NUMBER` | Fallback wa.me number |
| `CORS_ORIGIN` | Comma-separated allowed frontend origins |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | Onboarding/receipt emails |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Billing |
| `WAYNERING_*` (7 vars) | AI voice-calling integration |

Full details for every one of these live in `plotra-backend/.env.example`.

---

## 7. Deploy checklist (AWS)

1. **Database**: provision Postgres, run `npm run migrate`. If merging PR #20 (builder rating), its migration adds `rating_basis`/`rating_is_ai_assessment` and widens `overall_rating` — confirm it actually runs.
2. **Redis**: provision (ElastiCache or similar).
3. **S3 bucket**: for photo/media uploads.
4. **Backend API**: deploy `src/server.js` with every env var from §6.
5. **Backend workers**: deploy all 8 as **separate long-running processes**. Don't use `npm run workers` (all-in-one) in production.
6. **Web chat widget**: host `plotra-backend/demo/plotra-web-chat.html`, update its config to the real backend URL.
7. **Frontend**: `npm run build`. Set `VITE_GOOGLE_MAPS_API_KEY` (and `VITE_API_BASE_URL` if split-host) at build time.
8. **WhatsApp BSP webhook** → `POST /api/v1/webhooks/whatsapp`.
9. **Stripe webhook** (if billing is live) → `POST /api/v1/webhooks/stripe`.
10. **Run the landmark backfill** (§3) once the fix is deployed.

---

## 8. Smoke test after deploy

- [ ] Already-live listing: satellite doesn't appear, street view does, real photos show.
- [ ] Nearby-landmarks section: genuinely nearby, correctly categorized (won't be true for pre-existing listings until §3's backfill runs).
- [ ] Web chat: "flat available in [any building name]" creates a Flat listing + a builder-profile note in the reply.
- [ ] If PRs #10/#20 merged: a published builder profile shows its rating as `/10`; a synthesized one shows the basis text + disclaimer instead of a source link.
- [ ] If PRs #12/#13 merged: spot-check dashboard, admin panel, ops panel, a public listing — should read "Plotra" everywhere, one consistent color/font treatment, no leftover charcoal/brass or stray blue.
- [ ] Dashboard → Flat or Commercial listing → 🏗️ Link Builder button appears; Plot/Villa does not.
- [ ] Full checklist: `QA_TESTING_PROMPTS.md` in this repo — 9 ready-to-paste prompts for Claude for Chrome.

---

## 9. Notes on merged PR #3 (frontend, if anyone asks)

One of the merged PRs (`fix/lead-inbox-and-maps-bug`) was 6 weeks old and had drifted out of sync with `main`. Two of its four fixes turned out to be moot/redundant by the time it merged: its Maps bug fix was already independently fixed by a full rewrite of `PlotBoundaryTracer.jsx` already on `main`, and its "Lead Inbox" modal duplicated an already-shipped, better-integrated Leads page. Property Edit modal and Tenant drill-down (the other two fixes) merged in as originally written.
