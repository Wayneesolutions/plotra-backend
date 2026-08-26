# Plotra — Handover Document

**Date:** 2026-08-26
**Repos:** `Wayneesolutions/plotra-frontend` (React/Vite) + `Wayneesolutions/plotra-backend` (Node/Express)
**Status:** Everything below is merged into `main` on both repos, right now. Nothing is sitting on a branch or an open PR.

This doc is for whoever deploys this to AWS next. It covers what changed in this session, what the running system needs to actually work, and what to check once it's up.

---

## 1. What shipped this session

All of this is live on `main` in both repos — confirm with `git log --oneline -15` on each if you want to see it yourself.

### plotra-frontend
- **Satellite/street-view behavior fixed.** Satellite view now shows road/place labels while a dealer is dragging the pin to correct a location (was a blank image before). Once a listing goes live, satellite view drops away (it's a pin-correction tool only), but **street view now stays visible to buyers** on the public listing — it used to disappear along with satellite.
- **5 dealer/admin PRs merged**: WhatsApp number management in Settings, re-pointed multi-agent-WhatsApp gate, WhatsApp signup admin approval flow, plan-assignment dropdown for admin tenant management, and Lead Inbox / Property Edit modal / Tenant drill-down (a stale PR that needed manual conflict resolution — see §5).
- **Builder/developer profile UI extended from Flat-only to Flat + Commercial** (mall/retail units), matching the backend change below.
- **Cleanup**: removed a stray committed `dist.zip` build artifact, an orphaned unused component (`ListingMediaManager.jsx`, superseded by `DashboardListings.jsx`'s own inline photo modal), and a stale/incomplete duplicate of the web chat widget (`public/webchat.html` — the real one lives in the backend repo, see below).

### plotra-backend
- **New feature: chat-based builder/developer auto-linking.** A dealer can now type something like *"flat available in DLF Chandigarh One"* or *"retail space available in Elante Mall"* over WhatsApp **or** the web chat widget, and:
  - "Flat" is now a recognized property type in the shared GPT extraction (`listingExtractionService.js`) — it previously only recognized Plot/Villa/Commercial.
  - A named building/mall (`building_name`, a new extracted field) is enough on its own to create and geocode the listing — no separate address required.
  - The listing is automatically linked to a builder profile inline, right after creation (and again if the building name arrives on a later correction message) — same reuse-or-research logic the manual dashboard "Link Builder" button already used, just triggered from the conversation. The dealer gets a confirmation message either way.
  - Extended to **Commercial** listings too, not just Flat, since a mall retail unit has the same "developer/promoter" structure as a flat.
  - **The human moderation gate is completely unchanged** — nothing from this auto-link is ever shown to buyers until a tenant owner explicitly publishes the researched builder profile from the dashboard.
- **Cleanup**: removed the same stray `dist.zip` (byte-identical to the frontend's — it had ended up committed into this repo too, with no reason to be here).

**Not touched, but worth knowing about:** `src/middleware/tenantContext.js` is unwired (no route uses it) — that's deliberate, per its own header comment, kept as groundwork for a future centralized-tenancy pass. Left it alone rather than delete it.

---

## 2. Architecture quick reference

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

The backend is **not** a single process. In production you need the API server *and* all 8 workers running continuously (see `package.json`'s `worker:*` scripts, or the combined `npm run workers`). If you only deploy `src/server.js`, WhatsApp messages will be logged but never actually processed — nothing will geocode, nothing will get a reply, no builder research will run.

The **web chat widget** dealers actually use is `plotra-backend/demo/plotra-web-chat.html` — a static HTML file, not part of the React app. It needs to be hosted somewhere reachable (e.g. served statically by the backend, or uploaded to S3/CloudFront) and its `window.PLOTRA_CONFIG.API_ENDPOINT` / `PHOTO_ENDPOINT` pointed at wherever the backend actually ends up living.

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
| `REDIS_HOST` / `REDIS_PORT` | BullMQ — every async flow (WhatsApp, geo, AI research) depends on this |
| `GOOGLE_MAPS_API_KEY` | Geocoding, satellite/street-view image generation |
| `OPENAI_API_KEY` | Chat extraction (`gpt-4o-mini`) AND builder due-diligence research (web-search Responses API) — same key, both uses |
| `BSP_GATEWAY_URL` / `BSP_API_KEY` | WhatsApp send/receive |
| `PUBLIC_APP_URL` | Used to build every `/p/:slug` listing link sent back in chat |
| `WEB_CHAT_TENANT_ID` / `WEB_CHAT_AGENT_USER_ID` | **Required in production** (`NODE_ENV=production`) — the web chat endpoint refuses to process messages without both. Pin these to whichever tenant/user should own listings created through the public web widget. |

**Needed for specific features (leave blank to soft-disable that feature, not the whole app):**

| Var | Feature |
|---|---|
| `WHATSAPP_WEBHOOK_SECRET` | Verifies inbound WhatsApp webhook signatures — skipped if blank |
| `WHATSAPP_SHARED_NUMBER` | Fallback wa.me number for tenants without their own dedicated WhatsApp number |
| `CORS_ORIGIN` | Comma-separated allowed frontend origins in production |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | Onboarding/receipt emails — logged to console instead of sent if `SMTP_HOST` is blank |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Billing |
| `WAYNERING_*` (7 vars) | AI voice-calling integration — separate product, see `.env.example` for the full set |

Full details and comments for every one of these live in `plotra-backend/.env.example` — copy it, don't retype it by hand.

---

## 4. Deploy checklist (AWS)

1. **Database**: provision Postgres, then run `npm run migrate` (never edit old migration files — add a new one for any schema change). `npm run seed` only for a fresh/demo environment, not production.
2. **Redis**: provision (ElastiCache or similar) — shared by the API process and all 8 workers.
3. **S3 bucket**: for photo/media uploads (`s3Service.js`) — set the relevant AWS credentials/bucket vars per that file.
4. **Backend API**: deploy `src/server.js` (e.g. behind an ALB, ECS/Fargate, or EC2 + PM2). Set every env var from §3.
5. **Backend workers**: deploy all 8 as **separate long-running processes** (own ECS service/task each, or PM2 processes) — `worker:geo`, `worker:landmark`, `worker:vocallm`, `worker:whatsapp`, `worker:agentIntake`, `worker:localIntel`, `worker:builderDD`, `worker:wayneRingSync`. Don't just run `npm run workers` (concurrently) in production — that's a dev convenience, one process for all 8, with no per-worker restart isolation.
6. **Web chat widget**: host `plotra-backend/demo/plotra-web-chat.html` somewhere reachable (S3/CloudFront works fine, or serve it statically from the backend itself) and update its `PLOTRA_CONFIG.API_ENDPOINT`/`PHOTO_ENDPOINT` to the real backend URL before publishing the link to dealers.
7. **Frontend**: `npm run build` → static assets → S3+CloudFront (or wherever). Set `VITE_GOOGLE_MAPS_API_KEY` and, if split-host, `VITE_API_BASE_URL` at build time — Vite bakes these in at build, not runtime.
8. **WhatsApp BSP webhook**: point your BSP's inbound webhook at `POST /api/v1/webhooks/whatsapp` (or your BSP's configured path — see `src/routes/webhooks.js`) on the deployed backend URL.
9. **Stripe webhook** (if billing is live): point at `POST /api/v1/webhooks/stripe`, subscribed to `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`.

---

## 5. Smoke test after deploy

- [ ] Log into the dashboard, view a listing — satellite view shows road labels while pending; street view (not satellite) still shows once the listing is approved/live.
- [ ] Create a listing via the web chat widget (`demo/plotra-web-chat.html`) with a plain address — confirm it geocodes and previews.
- [ ] Create a listing via the web chat widget naming only a building — e.g. type "flat available in [any building name]" — confirm it creates the listing AND you get a builder-profile confirmation message back in the same conversation.
- [ ] Attach a photo via the web chat's 📷 button — confirm it uploads.
- [ ] Same building-name test over WhatsApp, if a test number is available.
- [ ] Dashboard → a Flat or Commercial listing → 🏗️ Link Builder button appears and works; a Plot/Villa listing does **not** show it.
- [ ] Admin panel: approve a pending request, confirm WhatsApp signup payment, change a tenant's plan — all from PRs merged this session.

---

## 6. Notes on PR #3 (if anyone asks)

One of the merged PRs (`fix/lead-inbox-and-maps-bug`, "Lead Inbox / Property Edit / Maps bug / Tenant drill-down") was 6 weeks old and had drifted out of sync with `main`. Two of its four fixes turned out to be moot/redundant by the time it merged:
- Its Maps bug fix was already independently fixed by a full rewrite of `PlotBoundaryTracer.jsx` already on `main` — took `main`'s version whole.
- Its "Lead Inbox" modal duplicated an already-shipped, better-integrated Leads page (`LeadsInbox.jsx`, with its own sidebar nav) — dropped the duplicate rather than ship two lead inboxes.

Property Edit modal and Tenant drill-down (the other two fixes in that PR) merged in as originally written — no issues there.
