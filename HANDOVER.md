# Plotra — Handover Document

**Date:** 2026-08-31 (latest work below; original doc from 2026-08-27 follows starting at §1, kept for history)
**Repos:** `Wayneesolutions/plotra-frontend` (React/Vite) + `Wayneesolutions/plotra-backend` (Node/Express)
**Status:** See "§0. Latest" immediately below for the newest work. Everything from §1 onward describes an older session and its own status line — by now most of that work has already merged to `main` on both repos; treat §1's own "not merged yet" language as stale and check GitHub directly if it matters.

This doc is for whoever deploys this next. §0 covers the most recent session's work, §1 covers an earlier session's work, §2–§6 are architecture/env/deploy/smoke-test reference (may not reflect everything merged since), and §7 is an even earlier session's handover, kept for history.

---

## §0. Latest — iOS map fullscreen toggle button fix (2026-08-31)

**Status: PR open, not yet merged.** [`Wayneesolutions/plotra-frontend#17`](https://github.com/Wayneesolutions/plotra-frontend/pull/17), branch `claude/fullscreen-toggle-apple-xcgv3b`.

### Background
`plotra-frontend` PR #16 (merged 2026-08-31, same day) added a custom expand/collapse (⤢/✕) button on the satellite and street-view maps in `PropertyMapMedia.jsx`, replacing Google Maps' native `fullscreenControl` — iOS Safari silently omits that native control on arbitrary elements (only `<video>` supports the real Fullscreen API there), which is why dealers on iPhone/iPad had no way to zoom in on the ~260px-tall satellite embed for precise pin placement. PR #16's fix used a plain CSS "fake fullscreen" overlay (`position: fixed`, full viewport) instead of the real Fullscreen API.

**The button was reported still not working on Apple devices after PR #16 shipped.** Root-caused by code review (two unrelated bugs, both specific to iOS Safari):

1. **`overflow-x: clip` on `<body>`** in `src/styles.css` (added earlier by the unrelated design-system PR #13, `@layer base` reset for `html`/`body`). iOS Safari has a long-standing WebKit bug where `position: fixed` descendants stop tracking the true viewport — becoming mispositioned or untappable — once `<body>` itself has non-`visible` overflow. That's exactly the CSS PR #16's fullscreen overlay depends on. **Fix:** moved the clip from `html`/`body` onto `#root` instead (`#root` isn't the page's native scrolling element, so the same horizontal-overflow prevention applies without tripping the bug).
2. **No isolated stacking context** on the map's wrap `<div>`. Google Maps injects its own internal panes (tile layer, overlay, float pane for controls, etc.) as descendants of the map container, and its float pane in particular ships with a z-index in the hundreds of thousands. Without `isolation: isolate` on the wrap, that pane's z-index gets compared against the button's z-index (5) in whichever ancestor stacking context is nearest — which the button loses, letting an invisible Maps pane sit on top of it and silently eat taps. **Fix:** added `isolation: isolate` to both the collapsed and expanded wrap styles in `PropertyMapMedia.jsx`.

### Files changed (PR #17)
- `src/components/PropertyMapMedia.jsx` — `isolation: isolate` on both wrap styles
- `src/styles.css` — moved `overflow-x: clip` from `html`/`body` to `#root`

### Verified
- `npm run build` succeeds (Vite, no errors)

### NOT verified — needs a real device
No iPhone/iPad/real iOS Safari was available in this session to confirm the button now actually works end-to-end. **Before merging PR #17**, on an actual iPhone or iPad in Safari:
- [ ] Open a pending listing's public page, tap the expand icon (⤢) on the satellite view — confirm the map goes fullscreen and the button visibly responds
- [ ] Tap ✕ (or the icon again) to exit — confirm it returns to the normal embedded size, not stuck fullscreen or blank
- [ ] While expanded, drag the pin (if `canAdjustLocation`) and confirm the "New location set — save it?" banner is visible and tappable, not hidden behind the map (this was the thing PR #16 already fixed — regression-check it)
- [ ] Repeat for the street-view panel
- [ ] Spot-check 2–3 other pages (landing page, dashboard) for a new horizontal scrollbar or clipped content — the `overflow-x: clip` move from `body` to `#root` should be behaviorally identical, but wasn't visually verified

### What's needed next
1. Someone with an actual Apple device runs the checklist above.
2. If it passes, merge PR #17.
3. If the button is *still* dead after this, the next thing to check is whether the deployed frontend's CDN/build cache is actually serving the new bundle (hard-refresh / cache-bust before assuming the code fix itself failed) — this session couldn't verify against a live deployment, only a local `vite build`.

`plotra-backend` was **not** touched for this fix — the bug and the fix are entirely in `plotra-frontend`; the backend has no fullscreen/UI code at all.

---

## ✅ Widget gap closed — one web chat widget now, action needed on your side

The previous version of this doc flagged two out-of-sync web chat widgets. That's resolved in code:

- **`plotra-backend/demo/plotra-web-chat.html` has been deleted.** It was the old static-file widget, didn't support per-tenant codes, and every doc reference to it (`BACKEND_API_SPEC.md`, `QA_TESTING_PROMPTS.md` in both repos, this file) has been updated to point at its replacement instead.
- **`plotra-frontend`'s `/widget` route (`ChatWidget.jsx`) is now the one and only web chat widget.** It supports per-tenant activation codes (§1.4) and is what §2/§4/§5 below now describe exclusively.

**What I could NOT do myself, because this session has no DNS/hosting/AWS access (same limitation as earlier in this session):**

Whatever currently serves `plotra.wayneesolutions.com` (per `BACKEND_API_SPEC.md`'s old config, that's where the deleted static file was expected to be reachable) needs to be re-pointed by hand:
- If `plotra.wayneesolutions.com` is a dedicated static-hosting target (S3/CloudFront bucket, Nginx `location` block, etc.) that served `plotra-web-chat.html` directly — either redirect it (HTTP 301) to the deployed `plotra-frontend`'s `/widget` path, or repoint the DNS record so that hostname resolves to wherever `plotra-frontend` is actually hosted, with `/widget` as the path tenants use.
- If it was just one page within a larger static site deploy, remove/redirect that one path instead of the whole hostname.
- Whichever way you do it: the end state should be that visiting `plotra.wayneesolutions.com` (or a specific path on it) lands on `plotra-frontend`'s `/widget` route, not a 404 or the deleted file.

This is a manual step — I can't reach your DNS/hosting provider from this session. Everything else in this section is done and pushed to the branch.

---

## 1. What shipped this session

Five pieces of work, all on branch `claude/plotra-code-fixes-eboqnb`, all requested and built in the same session. None merged yet.

### 1.1 Fix: agent WhatsApp intake mishandled `awaiting_approval` replies
**Backend commit `97422d7`.** In `agentIntakeController.js`, any message sent while a dealer's draft listing was `awaiting_approval` — even a non-informative one like "Hello", or an unrelated new listing's address — was silently glued onto the pending draft's `accumulated_text` and treated as a correction. Now:
- The incoming text is run through GPT extraction **on its own** (before the row-locking transaction, so the API call never holds a DB lock) to decide what to do.
- No extractable info at all → reply reminding them the previous listing is still pending; `accumulated_text` untouched, no re-extraction.
- Extractable info whose address doesn't match the pending listing (loose substring-normalized comparison) → the old draft is marked **`abandoned`** (new status value; no DB migration needed — `agent_listing_drafts.status` has no check constraint, same as `approved`) and a **fresh draft** starts instead of merging text into the old one.
- A real same-property correction still works exactly as before.

### 1.2 Feature: optional phone on invite + edit-phone for existing team members
**Backend commit `acbc9ea`, frontend commit `7581520`.**
- New endpoint: `PATCH /api/v1/dashboard/users/:id` (owner-only, tenant-scoped) — lets an owner add/change a team member's phone after they've already been invited. Previously the only way to set `users.phone` was at invite time.
- `InviteUserModal.jsx` (a standalone modal component — **not currently imported/used anywhere**, but explicitly asked for) and `Settings.jsx`'s existing inline invite form both gained an optional Phone field with the note *"Add their WhatsApp number to let them create listings by texting Plotra directly."*
- `Settings.jsx` gained a **Team Members** list (owner-only) under "Invite a Team Member", with inline Edit/Save/Cancel for each member's phone, wired to the new PATCH endpoint.

### 1.3 Feature: agent self-registration via WhatsApp
**Backend commit `e6dbc57`, frontend commit `cd2cac8`.** A prospective agent can now text **"join as agent"** to start a conversational signup, entirely separate from the existing dealer listing-intake flow (`agentIntakeController.js`) and the buyer/lead path (`webhookController.js`) — neither touched.
- New migration: `pending_agent_signups` (tenant_id, name, phone, address, status `pending`/`approved`/`rejected`, plus an internal `accumulated_text`), RLS-enabled, one-pending-per-phone partial unique index.
- New `agentSignupController.js` + `agentSignupExtractionService.js` (GPT extraction of name/address) + **new worker `agentSignupWorker.js`** (queue `agent-signup-intake`) — same debounce(7s)+GPT-extraction+BullMQ pattern as `agent_listing_drafts`/`agentIntakeWorker.js`, kept fully separate.
- `webhookController.js` now checks for a signup attempt (keyword, or a continuing signup conversation) **before** falling through to the buyer path.
- New owner-only, tenant-scoped dashboard endpoints: `GET /api/v1/dashboard/agent-signups` (only rows with name+address both resolved — an in-progress conversation doesn't show up yet), `POST .../:id/approve` (creates the real `users` row, `role='agent'`, phone immediately live for agent-intake — no separate activation step, and generates a placeholder email + temp password since WhatsApp never collects a real email), `POST .../:id/reject`.
- `Settings.jsx` gained a "Pending Agent Signups" section (owner-only) with Approve/Reject, matching the interaction pattern of `AdminPanel.jsx`'s existing Pending Requests tab.
- **New worker process** — `npm run worker:agentSignup` (`src/workers/agentSignupWorker.js`) needs to run continuously alongside the other 8 workers. `package.json`'s `worker:*` scripts and the combined `workers` script were updated.

### 1.4 Feature: per-tenant web chat activation codes
**Backend commit `ca88207`, frontend commit `8970196`.** Replaces the single hardcoded `WEB_CHAT_TENANT_ID`/`WEB_CHAT_AGENT_USER_ID` env-var pair (one tenant per backend deployment, previously required to be set by hand) with a unique, human-typeable code per tenant, so the same web chat mechanism can serve every tenant.
- New migration: `tenants.web_chat_code` (unique, nullable) — generated **lazily** the first time an owner asks for it (not backfilled/patched into every tenant-creation code path).
- New owner-only endpoints: `GET /api/v1/dashboard/web-chat-code`, `POST .../regenerate`.
- New public endpoint: `POST /api/v1/chat/web/activate { code }` — validates a code, returns the tenant's business name.
- `webChatController.js`'s `resolveWebChatIdentity` now resolves the tenant by code first (attributing new listings to that tenant's **owner** user), falling back to the old env vars only when no code is sent at all — an existing single-tenant deployment keeps working unchanged, so **`WEB_CHAT_TENANT_ID`/`WEB_CHAT_AGENT_USER_ID` are no longer hard requirements**, just an optional fallback (see §3 update below).
- `Settings.jsx` gained a "Web Chat Widget" section (owner-only) showing/regenerating the tenant's code.
- **New widget**: `plotra-frontend`'s `ChatWidget.jsx`, mounted full-page at `/widget` (meant to be iframed on a tenant's own external site — same-origin from inside the iframe, so no per-tenant CORS config needed). Prompts for the code once, stores it (`localStorage`), then sends it as `tenant_code` on every `/api/v1/chat/web` and `/api/v1/chat/web/photo` call.

### 1.5 Cleanup: retired the old static web chat widget
**Backend-only, same branch, no separate commit hash beyond the one deleting `demo/plotra-web-chat.html`.** Discovered while writing up §1.4 that a second, pre-existing web chat widget already existed as a static HTML file (`plotra-backend/demo/plotra-web-chat.html`) — it didn't support per-tenant codes and was now redundant with §1.4's `/widget` route. Deleted it after confirming (via repo-wide search) nothing in either repo's code references it — only docs did, all updated: `BACKEND_API_SPEC.md` (marked historical, endpoint contract unchanged), `QA_TESTING_PROMPTS.md` in both repos (now point at `/widget` + an activation-code step), and this file. **See the "✅ Widget gap closed" section above for a manual DNS/hosting step still needed on your end.**

---

## 2. Architecture quick reference

```
plotra-frontend (Vite/React SPA)
  └─ built as static assets, served from S3+CloudFront, Vercel, or similar
  └─ talks to plotra-backend over VITE_API_BASE_URL
  └─ /widget route (NEW, §1.4) — public, iframe-embeddable, per-tenant-code-gated web chat

plotra-backend (Node/Express API)
  ├─ src/server.js               — the API process (npm start)
  ├─ src/workers/*.js             — 9 SEPARATE long-running processes (was 8 — agentSignupWorker.js is NEW, §1.3), not part of the API process
  ├─ PostgreSQL                   — primary datastore (Knex migrations)
  ├─ Redis                        — BullMQ job queues (geo-enrichment, WhatsApp send, AI extraction, builder research, agent signup, etc.)
  ├─ S3                           — photo/media storage
  └─ External APIs: Google Maps, OpenAI (gpt-4o-mini + web-search Responses API),
     a WhatsApp BSP (Meta Cloud API or similar), Stripe, SMTP, WayneRing (voice calling)
```

The web chat widget is **`plotra-frontend`'s `/widget` route** (`ChatWidget.jsx`) — the old static `plotra-backend/demo/plotra-web-chat.html` (referenced by the previous session, §7, as "the real one") has been deleted; see §1.5. `/widget` is iframe-embeddable on a tenant's own site and gated by their per-tenant activation code (§1.4). **Still needs a manual DNS/hosting repoint** — see the "✅ Widget gap closed" section at the top of this doc.

The backend is **not** a single process. In production you need the API server *and* all 9 workers running continuously (see `package.json`'s `worker:*` scripts, or the combined `npm run workers` for **dev only**). If you only deploy `src/server.js`, WhatsApp messages will be logged but never actually processed — nothing will geocode, nothing will get a reply, no builder research or agent signup will run.

---

## 3. Environment variables required

### Frontend (`.env` at build time — Vite only exposes `VITE_`-prefixed vars)

| Var | Required? | Notes |
|---|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | **Yes** | Satellite/street-view map, PlotBoundaryTracer |
| `VITE_API_BASE_URL` | Only if frontend/backend are on different hosts (e.g. S3 + EC2 split) | Leave blank if same origin |

### Backend (`.env` on the server / worker processes)

**Hard requirements — the app will refuse to start or will silently misbehave without these:**

| Var | Why |
|---|---|
| `JWT_SECRET` | Server **refuses to start** without it — generate with `openssl rand -hex 32` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | PostgreSQL connection |
| `REDIS_HOST` / `REDIS_PORT` | BullMQ — every async flow (WhatsApp, geo, AI research, agent signup) depends on this |
| `GOOGLE_MAPS_API_KEY` | Geocoding, satellite/street-view image generation |
| `OPENAI_API_KEY` | Chat extraction (`gpt-4o-mini`), agent-signup extraction, and builder due-diligence research (web-search Responses API) — same key, all uses |
| `BSP_GATEWAY_URL` / `BSP_API_KEY` | WhatsApp send/receive |
| `PUBLIC_APP_URL` | Used to build every `/p/:slug` listing link sent back in chat |

**No longer a hard requirement (changed this session, §1.4):**

| Var | Status |
|---|---|
| `WEB_CHAT_TENANT_ID` / `WEB_CHAT_AGENT_USER_ID` | **Now optional.** Per-tenant web chat activation codes (§1.4) are the primary mechanism — each tenant gets their own code from Settings → Web Chat Widget. These two env vars still work as a fallback single-tenant pin **only when a request sends no code at all**; leave unset entirely if you're relying on per-tenant codes. |

**Needed for specific features (leave blank to soft-disable that feature, not the whole app):**

| Var | Feature |
|---|---|
| `WHATSAPP_WEBHOOK_SECRET` | Verifies inbound WhatsApp webhook signatures — skipped if blank |
| `WHATSAPP_SHARED_NUMBER` | Fallback wa.me number for tenants without their own dedicated WhatsApp number |
| `CORS_ORIGIN` | Comma-separated allowed frontend origins in production |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | Onboarding/receipt emails — logged to console instead of sent if `SMTP_HOST` is blank |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Billing |
| `WAYNERING_*` (7 vars) | AI voice-calling integration — separate product, see `.env.example` for the full set |

Full details and comments for every one of these live in `plotra-backend/.env.example` — copy it, don't retype it by hand. (Not updated this session — the two var-status changes above aren't reflected in the file's comments yet.)

---

## 4. Deploy checklist (AWS)

1. **Merge the branch first.** `claude/plotra-code-fixes-eboqnb` on both repos needs review + a merge to `main` before anything below applies — nothing in §1 is live yet.
2. **Database**: provision Postgres, then run `npm run migrate` (never edit old migration files — add a new one for any schema change). This session adds **two new migrations**: `pending_agent_signups` and `tenants.web_chat_code`. `npm run seed` only for a fresh/demo environment, not production.
3. **Redis**: provision (ElastiCache or similar) — shared by the API process and all 9 workers.
4. **S3 bucket**: for photo/media uploads (`s3Service.js`) — set the relevant AWS credentials/bucket vars per that file.
5. **Backend API**: deploy `src/server.js` (e.g. behind an ALB, ECS/Fargate, or EC2 + PM2). Set every env var from §3 — note `WEB_CHAT_TENANT_ID`/`WEB_CHAT_AGENT_USER_ID` are now optional.
6. **Backend workers**: deploy all **9** as **separate long-running processes** (own ECS service/task each, or PM2 processes) — `worker:geo`, `worker:landmark`, `worker:vocallm`, `worker:whatsapp`, `worker:agentIntake`, **`worker:agentSignup` (NEW)**, `worker:localIntel`, `worker:builderDD`, `worker:wayneRingSync`. Don't just run `npm run workers` (concurrently) in production — that's a dev convenience, one process for all 9, with no per-worker restart isolation.
7. **Web chat widget**: build+deploy `plotra-frontend` (already covered by step 8 below) and point tenants at `https://<your-frontend-host>/widget` (embed via `<iframe>` on their own site). The old static `demo/plotra-web-chat.html` is deleted — if `plotra.wayneesolutions.com` (or wherever it used to be hosted) still needs to resolve somewhere, repoint its DNS/hosting to this `/widget` path by hand (manual step, not done as part of this session — see the "✅ Widget gap closed" section at the top).
8. **Frontend**: `npm run build` → static assets → S3+CloudFront (or wherever). Set `VITE_GOOGLE_MAPS_API_KEY` and, if split-host, `VITE_API_BASE_URL` at build time — Vite bakes these in at build, not runtime.
9. **WhatsApp BSP webhook**: point your BSP's inbound webhook at `POST /api/v1/webhooks/whatsapp` (or your BSP's configured path — see `src/routes/webhooks.js`) on the deployed backend URL.
10. **Stripe webhook** (if billing is live): point at `POST /api/v1/webhooks/stripe`, subscribed to `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`.

---

## 5. Smoke test after deploy

**This session's work:**
- [ ] Send a message on WhatsApp to a dealer number while their draft listing is `awaiting_approval` — a non-informative reply ("Hello") gets a "still pending approval" reminder, not a corrupted draft; a genuinely different address starts a fresh draft instead of merging.
- [ ] Dashboard → Settings → invite a team member with a phone number; confirm they appear in the new Team Members list; edit an existing member's phone inline and confirm it saves.
- [ ] Text **"join as agent"** to a tenant's WhatsApp number from an unregistered phone; provide name/area when asked; confirm the request appears under Settings → Pending Agent Signups; Approve it and confirm the same phone number can now use the existing WhatsApp listing-intake flow immediately.
- [ ] Dashboard → Settings → Web Chat Widget: confirm a code is shown, Regenerate produces a new one.
- [ ] Go to the deployed `/widget` route: enter the tenant's code, confirm it activates and shows the tenant's business name, then create a listing via chat and confirm it lands under that tenant.
- [ ] Confirm `plotra.wayneesolutions.com` (or wherever the old widget was reachable) now lands on `/widget`, not a 404 or the deleted file — this depends on the manual DNS/hosting step above having been done.

**Previous session's work (still applicable, unchanged):**
- [ ] Log into the dashboard, view a listing — satellite view shows road labels while pending; street view (not satellite) still shows once the listing is approved/live.
- [ ] Create a listing via the web chat widget with a plain address — confirm it geocodes and previews.
- [ ] Create a listing via the web chat widget naming only a building — e.g. type "flat available in [any building name]" — confirm it creates the listing AND you get a builder-profile confirmation message back in the same conversation.
- [ ] Attach a photo via the web chat's 📷 button — confirm it uploads.
- [ ] Same building-name test over WhatsApp, if a test number is available.
- [ ] Dashboard → a Flat or Commercial listing → 🏗️ Link Builder button appears and works; a Plot/Villa listing does **not** show it.
- [ ] Admin panel: approve a pending request, confirm WhatsApp signup payment, change a tenant's plan.

---

## 6. Notes on PR #3 (if anyone asks) — from the previous session, unrelated to this one

One of the merged PRs (`fix/lead-inbox-and-maps-bug`, "Lead Inbox / Property Edit / Maps bug / Tenant drill-down") was 6 weeks old and had drifted out of sync with `main`. Two of its four fixes turned out to be moot/redundant by the time it merged:
- Its Maps bug fix was already independently fixed by a full rewrite of `PlotBoundaryTracer.jsx` already on `main` — took `main`'s version whole.
- Its "Lead Inbox" modal duplicated an already-shipped, better-integrated Leads page (`LeadsInbox.jsx`, with its own sidebar nav) — dropped the duplicate rather than ship two lead inboxes.

Property Edit modal and Tenant drill-down (the other two fixes in that PR) merged in as originally written — no issues there.

---

## 7. Previous session's handover (2026-08-26) — for history, still accurate for what it covers

**Status at the time:** merged into `main` on both repos.

### plotra-frontend
- **Satellite/street-view behavior fixed.** Satellite view now shows road/place labels while a dealer is dragging the pin to correct a location (was a blank image before). Once a listing goes live, satellite view drops away (it's a pin-correction tool only), but **street view now stays visible to buyers** on the public listing — it used to disappear along with satellite.
- **5 dealer/admin PRs merged**: WhatsApp number management in Settings, re-pointed multi-agent-WhatsApp gate, WhatsApp signup admin approval flow, plan-assignment dropdown for admin tenant management, and Lead Inbox / Property Edit modal / Tenant drill-down (a stale PR that needed manual conflict resolution — see §6 above).
- **Builder/developer profile UI extended from Flat-only to Flat + Commercial** (mall/retail units), matching the backend change below.
- **Cleanup**: removed a stray committed `dist.zip` build artifact, an orphaned unused component (`ListingMediaManager.jsx`, superseded by `DashboardListings.jsx`'s own inline photo modal), and a stale/incomplete duplicate of the web chat widget (`public/webchat.html` — the real one lived in the backend repo at the time, see below — **that backend copy has since been deleted too, see §1.5 above; the widget now lives at plotra-frontend's `/widget` route**).

### plotra-backend
- **New feature: chat-based builder/developer auto-linking.** A dealer can now type something like *"flat available in DLF Chandigarh One"* or *"retail space available in Elante Mall"* over WhatsApp **or** the web chat widget, and:
  - "Flat" is now a recognized property type in the shared GPT extraction (`listingExtractionService.js`) — it previously only recognized Plot/Villa/Commercial.
  - A named building/mall (`building_name`, a new extracted field) is enough on its own to create and geocode the listing — no separate address required.
  - The listing is automatically linked to a builder profile inline, right after creation (and again if the building name arrives on a later correction message) — same reuse-or-research logic the manual dashboard "Link Builder" button already used, just triggered from the conversation. The dealer gets a confirmation message either way.
  - Extended to **Commercial** listings too, not just Flat, since a mall retail unit has the same "developer/promoter" structure as a flat.
  - **The human moderation gate is completely unchanged** — nothing from this auto-link is ever shown to buyers until a tenant owner explicitly publishes the researched builder profile from the dashboard.
- **Cleanup**: removed the same stray `dist.zip` (byte-identical to the frontend's — it had ended up committed into this repo too, with no reason to be here).

**Not touched, but worth knowing about:** `src/middleware/tenantContext.js` is unwired (no route uses it) — that's deliberate, per its own header comment, kept as groundwork for a future centralized-tenancy pass. Left it alone rather than delete it.
