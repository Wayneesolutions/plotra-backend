# Plotra — Everything Added/Changed (Full Session Summary)

**Covers:** 2026-08-25 evening → 2026-08-26 late evening, across `plotra-frontend` and `plotra-backend`.
**Purpose:** a complete, plain-language record of every feature, fix, and cleanup — separate from `HANDOVER.md`, which is the deploy-ops/PR-merge-order doc. This one is "what did we actually build."

Each item says whether it's **live on `main`** or **sitting in an open PR** (see `HANDOVER.md` for the exact PR list/links/merge order).

---

## Frontend — new features

- **Street view now stays on public listings after approval.** Satellite view (the pin-correction tool) drops away once a listing goes live, same as before — but street view now stays visible to buyers, alongside the dealer's real photos. Previously both disappeared together. *(Live on `main`.)*
- **Satellite view shows road/place labels while editing.** Switched from a bare satellite tile to Google's "hybrid" tile (imagery + labels), so a dealer dragging the pin can actually orient themselves against roads/landmarks instead of a blank aerial photo. *(Live on `main`.)*
- **Builder/developer profile section now applies to Commercial listings, not just Flats.** The "🏗️ Link Builder" button, the public developer-profile section (rating, possession record, nearby-project comparisons) — all extended to malls/retail units, matching the backend change. *(Live on `main`.)*
- **Builder rating shown as `/10`, with AI-assessment disclosure.** When a builder has no real published rating, the page now shows a synthesized "Plotra's Assessment" score with a plain-English basis and an explicit disclaimer, instead of just showing nothing. *(Open PR — `plotra-frontend#10`.)*
- **WhatsApp number management** in Settings — add/remove/set-default for a tenant's buyer-facing WhatsApp numbers (distinct from a dealer's personal number). *(Live on `main`, merged from an existing PR.)*
- **Per-listing WhatsApp agent assignment**, re-pointed to the correct plan-gate (`max_whatsapp_numbers`) instead of the old boolean flag. *(Live on `main`.)*
- **Admin: WhatsApp signup approval flow** — handles Tier-1 WhatsApp signups (no dashboard login), shows a "payment link sent" confirmation instead of crashing, and a new "Awaiting Payment Confirmation" section with a one-click activate button. *(Live on `main`.)*
- **Admin: plan-assignment dropdown** on the All Tenants tab — move a tenant to a different plan without leaving the page. *(Live on `main`.)*
- **Property Edit modal** — edit fields, deactivate/reactivate, permanently delete a listing, from a new ✎ Edit button on every card. *(Live on `main`.)*
- **Tenant drill-down modal** — clicking a tenant row in admin now opens plan/owner/listings/usage detail with Suspend + Change Plan actions (previously did nothing). *(Live on `main`.)*

## Frontend — fixes

- **"WayneState Pro" branding replaced with "Plotra"** across every still-live page — public listing page, reset-password, and comment headers. (Your team had already fixed the dashboard/admin sidebar; this caught what was missed.) *(Open PR — `plotra-frontend#12`.)*
- **One unified color palette and font system app-wide**, replacing three different design systems that had accumulated (a legacy blue+Inter system, a charcoal/brass/teal "WayneState Pro" system, and the new Tailwind system your team built today for 8 new pages). 19 components recolored/refonted onto the new system's tokens, no structural rewrites. *(Open PR — `plotra-frontend#13`, stacked on #12.)*

## Frontend — cleanup

- Removed a stray committed `dist.zip` build artifact.
- Removed `ListingMediaManager.jsx` — an orphaned, unused component; the dashboard's own inline photo modal already does the same job.
- Removed `public/webchat.html` — a stale, incomplete duplicate of the web chat widget (no photo upload) that predates and duplicates the real one in the backend repo.

*(All three live on `main`.)*

---

## Backend — new features

- **Chat-based builder/developer auto-linking.** A dealer typing *"flat available in DLF Chandigarh One"* or *"retail space available in Elante Mall"* over WhatsApp or the web chat widget now:
  - Gets recognized as property type **Flat** (previously only Plot/Villa/Commercial were recognized in chat at all).
  - Creates and geocodes the listing off the building/mall name alone — no separate street address required.
  - Gets automatically linked to a builder profile inline, right in the conversation — reusing an existing profile or kicking off AI research on a new one, with a confirmation message back. Same underlying logic the manual dashboard button already used.
  - Works for **Commercial** (mall/retail) listings too, not just Flat.
  - The human moderation gate is completely unchanged — nothing from this is ever shown to buyers until a tenant owner explicitly publishes it.
  *(Live on `main`.)*
- **Builder rating widened from a strict "0-5, only if a real published rating exists" score to a 0-10 scale that can also be a synthesized "ability to deliver" assessment** — built from the same cited facts (delivery history, financial condition, legal issues, leadership record) when no external rating exists, plus a best-effort comparison to other developers in the same city/price segment. Never invented with zero grounding: a company nothing was found about still gets no rating at all. Leadership/promoter info stays scoped to professional/corporate record — no personal-life details about named individuals. *(Open PR — `plotra-backend#20`, includes a DB migration.)*
- **Landmark backfill script** (`scripts/backfillLandmarks.js`) — re-queues nearby-landmark extraction for listings whose data predates the landmark fix below. `--dry-run`, `--tenant`, `--limit` flags for a safe staged rollout. *(Open PR — `plotra-backend#21`.)*

## Backend — fixes

- **Nearby-landmark data (schools/hospitals/markets/transit) was wrong — now fixed.** Two real bugs in `landmarkWorker.js`, affecting every listing regardless of type:
  1. Results were mislabeled — anything Google didn't tag cleanly fell back to "market" by default, regardless of which category search actually found it.
  2. The "nearest 3" weren't actually the nearest — no distance ranking was requested from Google, so results came back ranked by prominence/fame instead.
  Also switched "market" to search Google's `supermarket` type instead of `shopping_mall` (closer to what "nearby market" means in a Punjab/Tier-2-3 town), and deduped results across categories.
  *(Live on `main`. Needs the backfill script above to fix already-existing listings' data — see `HANDOVER.md` §3.)*
- **BullMQ dedup fix** (your team's own fix) — a previously-failed extraction job with a static jobId was permanently blocking new extract jobs for the same draft, silently stalling a dealer's WhatsApp conversation. *(Live on `main`.)*

## Backend — cleanup

- Removed a stray committed `dist.zip` — byte-identical to the frontend's, had ended up in this repo with no reason to be here. *(Live on `main`.)*

---

## Documentation added (both repos)

- **`HANDOVER.md`** — deploy-focused: what's live vs. pending, architecture, every required env var, AWS deploy checklist, smoke-test list, full open-PR ledger with merge order.
- **`QA_TESTING_PROMPTS.md`** — 9 ready-to-paste prompts for Claude for Chrome (or any browser-driving agent) to verify the session's features on the live deployed site: satellite/street-view behavior, plan tiers, web chat (plain + building-name recognition), builder profile UI, WhatsApp channel parity, and the 5 merged admin PRs.
- **This file** — the plain-language "what did we build" record.

---

## What was investigated but NOT built (by design, or pending your decision)

- **Web chat widget photo upload / real vs. scripted conversation** — turned out to already exist and already be real (dynamic GPT-backed, not canned) in `plotra-backend/demo/plotra-web-chat.html`; an earlier, incomplete duplicate in the frontend repo was the one actually missing photo upload, and has since been removed.
- **A fully AI-synthesized, freely comparative builder rating with no grounding requirement** — you explicitly chose the "let AI freely rate/compare builders 0-10" option; what shipped still requires at least one cited fact to exist before synthesizing a score (never a rating with literally nothing behind it) — see `plotra-backend#20`.
- **Dashboard/admin/ops full migration to the new Tailwind/TypeScript page architecture** (as opposed to just recoloring the existing inline-style components onto the new palette) — not attempted; your team is mid-migration on the public-facing pages specifically, and a parallel full architectural rewrite of the dashboard risked colliding with that in-progress work.
