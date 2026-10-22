# Handover: 22 Oct fixes (role flow, live plans, trial visibility, Razorpay, templates)

Branch `claude/beautiful-albattani-x2u2lm`, built on `main` (PR #68 dealer-trial already merged). **One migration** (`20261022_01_visitor_flow_razorpay_templates.js`, additive, `down` reverses it). Backend only; the frontend items are listed at the end.

## The bug list, one by one

| # | Problem | What changed |
|---|---|---|
| A | After a visitor became a seller lead, every message got the owner reply (greeting, plan question too) | The Plotraa-number conversation is now a state machine (`visitorFlowMachine.js`). A finished owner flow answers `hi` with a short "details are with the team", `plan` with the live plan list, and a question with the assistant. In the assistant itself, an open seller lead only "continues the sale" when the message actually carries sale details (`looksLikeSaleDetails`). |
| B | Agent saw old hardcoded Lite 3000 / Growth 10000 / Unlimited 20000 | The agent plan menu now reads the **live `plans` table** (`getActivePlansInMenuOrder`), the same catalogue as the website, Admin Plans tab and the assistant. The old packages are deactivated in the migration (rows stay). The dealer's choice is stored in `users.selected_plan_key`. `plan 2` changes the plan any time; a bare `2` only before a plan is chosen (otherwise it is listing text). |
| E | A visitor tagged as seller could never become a dealer; "join" / "main dealer hoon" did nothing | An explicit statement always switches the role (`explicitRole`: join, judna hai, main dealer hoon, join as agent, Gurmukhi/Devanagari variants, ...), also in the assistant (`isExplicitDealerIntent` forces the join path even with an open seller lead). "menu" changes role any time. |
| D | The AI made up plan facts ("yearly pe koi extra benefit nahi") | Plans are monthly only (knowledge text says so). A yearly/annual question gets a **fixed** reply (monthly only, no yearly details, support number). If the model still mentions yearly when the person did not, the reply is replaced by that fixed text. |
| C | Fixed replies (greeting, plan list) answered Gurmukhi in Roman | All fixed texts live in `src/utils/i18n.js` in four variants (English, Hinglish, Gurmukhi, Devanagari), chosen from the script of the latest message (short messages keep the last variant). Agent greeting/help/plan list/trial messages and the role menu use it. A test checks every key has all four variants with the same placeholders. |
| - | First message does not ask the role | On the Plotraa platform number the first message always gets the menu *1 Buyer / 2 Owner / 3 Dealer*. No guessing. A person who **states** their role ("main dealer hoon", "kothi bechni hai", "join") skips the menu: that is what they said. |
| - | Dealer join not step by step, no trial/payment mention | Dealer: name -> area -> request filed (`pending_agent_signups`, same table Admin approves). The first question and the final message explain the 7-day free trial and that a plan is paid after it (payment link / QR). |
| - | Owner details not one by one | Owner: type -> size -> location -> price -> photos (up to 5, sent on WhatsApp, stored in S3, `seller_leads.photo_urls`). The lead is saved progressively, so a half-finished lead still reaches the team. Details in the first message are not asked again. `skip` moves on; two unclear answers stop the loop (the raw text is kept). |
| - | Buyer not step by step | Buyer: budget -> area -> type -> size -> search (existing marketplace search, budget applied as a filter, deliveries logged). No match: offers a new search or `call` (support callback request). |
| - | Trial invisible | See "Trial everywhere" below. |
| - | No Razorpay | See "Razorpay" below. |
| - | No templates | See "Templates" below. |
| - | Template send had no Meta id / error log | `whatsapp_template_sends`: template, phone, variables, Meta message id, status (queued/sent/delivered/read/failed) and error. Meta delivery receipts (`statuses` in the inbound webhook) update the same row. Admin: `GET /api/v1/admin/whatsapp-template-sends?status=failed`. |
| - | Existing 3 templates: parameter count unverified | Read from the code and pinned in `EXISTING_TEMPLATES` + a test: **support alert 3** body variables, **call enquiry 3 + 1 quick-reply button**, **re-engagement 1**. The worker now refuses (and logs) a send whose count differs (`expectedParams`). Compare with Meta Business Manager: `docs/WHATSAPP_TEMPLATES.md`. |
| - | Old converted dealers: no trial, no plan, `DEALER_UNPAID` | `node scripts/repairConvertedDealers.js` (dry run) then `--apply`. See "Deploy". The conversion script now grants the trial itself. The `DEALER_UNPAID` error says why (trial ended on a date / payment overdue / blocked converted dealer) and points to the script. |

## Role flow (Plotraa number only)

`src/services/visitorFlowMachine.js` (pure decisions, unit-tested) + `visitorFlowService.js` (state in `whatsapp_conversations`, seller leads, search, join request, replies). Hooked in `webhookController.js` after the registered-agent branch and the call-enquiry reply check, before the old signup/assistant path. Not used on a dealer's own number (those customers still get the dealer assistant + search). `VISITOR_FLOW=off` restores the old behaviour.

- A question in the middle of a step ("plan kya hai?") is answered (plan list or the assistant in answer-only mode, which cannot start a signup or create a lead) and the same step is asked again.
- State is dropped after 3 days of silence in an unfinished flow, 30 days after a finished one (the menu comes again).
- Unlike before, a buyer typing "plots in Dugri" as the very first message gets the menu first (that is the requested behaviour); their first message is used to pre-fill type/size/budget.

## Trial everywhere

- **Chat:** `plan` / `mera plan` / `trial kab tak hai` is answered by the system: the dealer's plan, status (trial / paid / trial ended) and **trial end date + days left**. Welcome, reminders and expiry messages carry the date and a payment link.
- **Dashboard:** `GET /api/v1/dashboard/billing/trial` returns `billing` (`status` trial|paid|expired|none, `days_left`, `trial_ends_at`, `plan_label`, `pay_url`, `online_payment_enabled`) and a ready `banner` (`show`, `tone`, `en`, `hi`). The login response also carries `billing`. `POST /api/v1/dashboard/billing/payment-link` (dealer only) returns a Razorpay link for a plan.
- **Admin:** `GET /api/v1/admin/agents-payments` now has `billing_status` (trial/paid/expired/none), `billing_reason`, `trial_days_left`, `plan_label`. Payment submissions list shows `source` (receipt/razorpay) and plan.
- Approving a **receipt** now also moves a dealer's own account onto the plan they chose (before, the super admin had to change it by hand).

## Razorpay

`razorpayService.js` + `POST /api/v1/webhooks/razorpay`.

1. A dealer picks a plan on WhatsApp (`plan`, then the number) -> a payment link (notes: `product=plotraa`, user, tenant, plan) is created and sent. Trial reminders carry a link too. If Razorpay is not configured or the call fails, the plan's QR (`plans.qr_code_url`, editable via `PATCH /admin/plans/:key`) or the receipt flow is used; with neither, the team gets a support request.
2. Razorpay calls the webhook with `payment_link.paid`: signature checked on the **raw** body with `RAZORPAY_WEBHOOK_SECRET` (without the secret nothing is processed, 503), then **only** events with `notes.product == plotraa` **and** a link in our own `razorpay_payment_links` table are acted on. Waynur's events on the shared account are acknowledged and ignored.
3. Activation (idempotent, amount must cover the link): payment recorded as approved, `can_add_listing` back on, plan stored, the dealer's account moved onto the paid plan, and a WhatsApp confirmation sent. Expired/cancelled links are marked.

Razorpay dashboard: webhook URL `https://<api-host>/api/v1/webhooks/razorpay`, events `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`. **Waynur's own webhook handler must likewise ignore events without its own marker**; ours never touches their payments.

## Templates

Seven new templates (dealer welcome + set-password link, sub-dealer invite, forgot password, trial reminder, trial expiry, payment received, lead assigned): exact text, variable count and env names in `docs/WHATSAPP_TEMPLATES.md`. The worker sends **free text while the person's 24h window is open** (tracked in `whatsapp_contact_windows`, updated on every inbound message) and the template otherwise; if Meta rejects a template it tries free text once and logs the template error either way. A send whose variable count is wrong never reaches Meta.

## Deploy

```
git pull && npm ci && npm run migrate
# env (see .env.example): RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET; optional WA_TPL_* names
pm2 restart all --update-env        # API and the outbound + payment-reminder workers changed
```

Then, once, with a DB backup:

```
node scripts/repairConvertedDealers.js            # dry run: dealers moved earlier that have no trial
node scripts/repairConvertedDealers.js --apply    # 7-day trial from now, listings back on, cycle restarted
```

Dealers who really paid before are left alone. After this, assigning a lead to them works (`DEALER_UNPAID` only for dealers whose trial ended / payment is overdue).

Meta: create the 7 templates (names in the doc), confirm the 3 existing ones have the variable counts above, make sure the webhook subscription includes `messages` (delivery receipts arrive there).

## Verified

- `npm test`: 194 pass (162 before + 32 new: `test/visitorFlow.test.js`, `test/billingTemplates.test.js`).
- Against a local Postgres 16 with all 59 migrations (including `down` + `up` of the new one): role flow end to end through `handleVisitorFlow` (menu, owner steps with the lead saved correctly, greeting/plan after the lead, seller -> dealer via "join" filing the request, buyer search, Gurmukhi stays Gurmukhi, yearly fixed reply).
- Real API server + real `whatsappOutboundWorker` + Redis + Postgres against a mock BSP that answers like Meta: inbound webhook -> menu delivered; window open -> free text, window closed -> template with the right variable count; Meta message id stored; delivery receipts update the row; rejected template (132001) logged and free text tried; wrong variable count refused before Meta; Razorpay webhook: bad signature 401, Waynur event ignored (nothing activated), Plotraa event activates plan + sends the payment-received template, replay is a no-op.

## Not verified (needs the real accounts)

- Real WhatsApp delivery of the new templates (they must be created and approved first) and Meta's real status payloads.
- Real Razorpay API call (`POST /v1/payment_links`) and a real `payment_link.paid` payload shape. The code reads `payload.payment_link.entity` (id, amount_paid, notes) and `payload.payment.entity` (id, amount); check one test payment and look at `[Razorpay]` in the API log.
- LLM-dependent paths (assistant answers inside the flow, buyer free-text search) were only run with the model disabled.
- RLS as the real app DB user (the local run is a superuser). New tables have no RLS, same as `plans`/`assistant_messages`.

## Frontend / outside code

- Dashboard: show `banner` from `/dashboard/billing/trial` (or `billing.banner` from login) at the top of the panel, with a **Pay now** button calling `POST /dashboard/billing/payment-link` and opening `url`.
- Admin: trial/paid/expired badge + days left on the agents-payments table (`billing_status`, `trial_days_left`); a QR field on the Plans tab (`qr_code_url`); optionally a Template sends tab on `/admin/whatsapp-template-sends` and a payment links list (`/admin/payment-links`, `POST /admin/dealers/:userId/payment-link` to create/send one by hand).
- The Razorpay link carries the monthly plan price (GST included, as on the website). Recurring auto-debit is not set up: each month is a new link (the 28-day reminder cycle is unchanged).
- Still free text (not templates): the monthly payment reminders after the first payment (day 28 / overdue) in `paymentReminderWorker.js`, and the sub-dealer / buyer messages inside an open chat. They reach people inside the 24h window only; say if you want a template for the monthly reminder too (the registry makes it a few lines).
