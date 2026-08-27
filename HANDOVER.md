# Plotra — Handover Document

**Date:** 2026-08-27
**Repos:** `Wayneesolutions/plotra-frontend` (React/Vite) + `Wayneesolutions/plotra-backend` (Node/Express)
**Status:** Everything in §1 below is pushed to branch **`claude/plotra-code-fixes-eboqnb`** on **both** repos — it is **NOT merged to `main`** and **no PR has been opened**. Whoever picks this up needs to review the branch and open/merge a PR on each repo before any of it reaches production. Everything from the previous session (§7) is still merged into `main` and unaffected.

This doc is for whoever deploys this next. §1 covers what changed in this session, §2–§6 are the up-to-date reference (architecture, env vars, deploy checklist, smoke tests) reflecting `main` + this branch combined, and §7 is the previous session's handover, kept for history.

---

## ⚠️ Known gap — read this before deploying the web chat work

This session **discovered a pre-existing web chat widget it didn't know about**: `plotra-backend/demo/plotra-web-chat.html` (a static HTML file, referenced in §7/§4 below as "the real one"). The new per-tenant activation-code work (§1.4) was built as a **second, separate widget** — `plotra-frontend`'s new `/widget` React route — without realizing that static file already existed and is what's presumably actually embedded/linked anywhere today.

Net effect right now:
- `demo/plotra-web-chat.html` still calls `POST /api/v1/chat/web` with **no `tenant_code`** — it only works via the old single-tenant `WEB_CHAT_TENANT_ID`/`WEB_CHAT_AGENT_USER_ID` env-var fallback (still supported, see §1.4), not the new per-tenant code system.
- The new React widget at `/widget` is the only one that actually supports entering a per-tenant code.
- **These two widgets are now out of sync** and only one should probably continue to exist. Two realistic paths, neither done yet:
  1. Patch `demo/plotra-web-chat.html` to add the same code-activation gate (small change: an activation step calling `POST /api/v1/chat/web/activate`, then send `tenant_code` on every `/web` and `/web/photo` call, same as `ChatWidget.jsx` does) — keeps the static-file deployment model.
  2. Retire `demo/plotra-web-chat.html` and standardize on `plotra-frontend`'s `/widget` route (iframe-embeddable) — one fewer thing to keep in sync, but changes the deploy story (§4 below documents both as they stand today).

**Recommend deciding this and closing the gap before telling any tenant to use their new code** — right now, only the not-yet-linked-anywhere `/widget` route actually honors it.

---

## 1. What shipped this session

Four pieces of work, all on branch `claude/plotra-code-fixes-eboqnb`, all requested and built in the same session. None merged yet.

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

### 1.4 Feature: per-tenant web chat activation codes (see the ⚠️ gap above)
**Backend commit `ca88207`, frontend commit `8970196`.** Replaces the single hardcoded `WEB_CHAT_TENANT_ID`/`WEB_CHAT_AGENT_USER_ID` env-var pair (one tenant per backend deployment, previously required to be set by hand) with a unique, human-typeable code per tenant, so the same web chat mechanism can serve every tenant.
- New migration: `tenants.web_chat_code` (unique, nullable) — generated **lazily** the first time an owner asks for it (not backfilled/patched into every tenant-creation code path).
- New owner-only endpoints: `GET /api/v1/dashboard/web-chat-code`, `POST .../regenerate`.
- New public endpoint: `POST /api/v1/chat/web/activate { code }` — validates a code, returns the tenant's business name.
- `webChatController.js`'s `resolveWebChatIdentity` now resolves the tenant by code first (attributing new listings to that tenant's **owner** user), falling back to the old env vars only when no code is sent at all — an existing single-tenant deployment keeps working unchanged, so **`WEB_CHAT_TENANT_ID`/`WEB_CHAT_AGENT_USER_ID` are no longer hard requirements**, just an optional fallback (see §3 update below).
- `Settings.jsx` gained a "Web Chat Widget" section (owner-only) showing/regenerating the tenant's code.
- **New widget**: `plotra-frontend`'s `ChatWidget.jsx`, mounted full-page at `/widget` (meant to be iframed on a tenant's own external site — same-origin from inside the iframe, so no per-tenant CORS config needed). Prompts for the code once, stores it (`localStorage`), then sends it as `tenant_code` on every `/api/v1/chat/web` and `/api/v1/chat/web/photo` call. **This is the widget that does NOT yet have a linked/known deployment location** — see the gap callout above.

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

There are now **two web chat widgets** (see the ⚠️ gap above) — pick one before telling tenants about their activation code:
- `plotra-backend/demo/plotra-web-chat.html` — static HTML, the one referenced by the previous session (§7) as "the real one." Does not yet support per-tenant codes.
- `plotra-frontend`'s `/widget` route (`ChatWidget.jsx`) — new this session, supports per-tenant codes, not yet linked/deployed anywhere specific.

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
7. **Web chat widget — resolve the ⚠️ gap above first**, then either:
   - host `plotra-backend/demo/plotra-web-chat.html` somewhere reachable (S3/CloudFront, or served statically by the backend) and update its `PLOTRA_CONFIG.API_ENDPOINT`/`PHOTO_ENDPOINT` — **after** patching it to send `tenant_code` (see the gap callout), or
   - build+deploy `plotra-frontend` and point tenants at `https://<your-frontend-host>/widget` (embed via `<iframe>` on their own site) instead.
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
- [ ] Whichever widget you resolve the ⚠️ gap with: enter the tenant's code, confirm it activates and shows the tenant's business name, then create a listing via chat and confirm it lands under that tenant.

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
- **Cleanup**: removed a stray committed `dist.zip` build artifact, an orphaned unused component (`ListingMediaManager.jsx`, superseded by `DashboardListings.jsx`'s own inline photo modal), and a stale/incomplete duplicate of the web chat widget (`public/webchat.html` — the real one lives in the backend repo, see below — **now itself out of date, see the ⚠️ gap at the top of this doc**).

### plotra-backend
- **New feature: chat-based builder/developer auto-linking.** A dealer can now type something like *"flat available in DLF Chandigarh One"* or *"retail space available in Elante Mall"* over WhatsApp **or** the web chat widget, and:
  - "Flat" is now a recognized property type in the shared GPT extraction (`listingExtractionService.js`) — it previously only recognized Plot/Villa/Commercial.
  - A named building/mall (`building_name`, a new extracted field) is enough on its own to create and geocode the listing — no separate address required.
  - The listing is automatically linked to a builder profile inline, right after creation (and again if the building name arrives on a later correction message) — same reuse-or-research logic the manual dashboard "Link Builder" button already used, just triggered from the conversation. The dealer gets a confirmation message either way.
  - Extended to **Commercial** listings too, not just Flat, since a mall retail unit has the same "developer/promoter" structure as a flat.
  - **The human moderation gate is completely unchanged** — nothing from this auto-link is ever shown to buyers until a tenant owner explicitly publishes the researched builder profile from the dashboard.
- **Cleanup**: removed the same stray `dist.zip` (byte-identical to the frontend's — it had ended up committed into this repo too, with no reason to be here).

**Not touched, but worth knowing about:** `src/middleware/tenantContext.js` is unwired (no route uses it) — that's deliberate, per its own header comment, kept as groundwork for a future centralized-tenancy pass. Left it alone rather than delete it.
