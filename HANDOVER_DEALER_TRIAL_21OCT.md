# Handover: dealer model, set-password link, 7-day trial, leads via super admin (21 Oct)

Branch `claude/dealer-trial` in both repos, built on top of `claude/qa-21oct` (merge that first). Backend first, then frontend. **One migration** (`20261021_01_dealer_trial_and_lead_details.js`, additive).

## Decisions implemented

| Decision | What changed |
|---|---|
| Only dealer, customer, super admin; sub-dealers created by dealers | WhatsApp joiner approved in Admin → Agent Signups now becomes a **dealer**: own tenant (internal only) + `owner` user = own admin panel. Dealers add sub-dealers from Settings → Add a Sub-dealer (role `agent` in their space). The old owner-side "Pending Agent Signups" approval is switched off (API returns empty / 403 with a message). |
| Send password link | No password is ever sent. Dealer welcome and sub-dealer invite carry a one-time **set-password link** (`/reset-password?token=…&setup=1`, valid 7 days). Login ID = WhatsApp number (login and forgot-password accept a phone; forgot-password for a phone sends the link on WhatsApp). |
| Trial 7 days, reminders after day 5 | `users.trial_ends_at` = approval + 7 days. Hourly job: reminder at 2 days left and 1 day left (once each), then on expiry new listings stop. Sub-dealers inherit the dealer's block (WhatsApp and dashboard). Existing listings stay live. Paying (approved receipt) turns it back on and moves them to the monthly cycle. |
| After trial, leads with super admin | Admin → Seller Leads → assign refuses a dealer whose trial ended / payment is pending (`DEALER_UNPAID`). |
| Seller lead not visible / no notification | Assigning now copies the details onto the dealer's lead, sends the dealer a WhatsApp alert, and shows it in their Leads (with the details). A dealer can hand a lead to a sub-dealer from Leads (sub-dealer gets a WhatsApp alert and sees it). Root cause was the old model: WhatsApp dealers were agents inside Wayne E's tenant, so a lead "for a dealer" never reached them. |

## Existing WhatsApp agents (already approved under Wayne E)
Not moved automatically. Script: `node scripts/convertWhatsappAgentsToDealers.js` (dry run) then `--apply` (optionally `--phone +91…`). Only touches users with the old `agent.<digits>@wa-signup.plotra.internal` email; moves them to their own dealer account with their own listings, drafts, payments, and leads that only touched their listings. No trial set for them. **Take a DB backup first.** They have no password link yet: after moving, use Forgot password with their number (link goes on WhatsApp).

## Env (optional)
`DEALER_TRIAL_DAYS` (7), `DEALER_TRIAL_PLAN` (`multi_user_basic`, needs dashboard so dealers get the panel during trial), `SETUP_LINK_TTL_HOURS` (168), `TRIAL_REMIND_DAYS_LEFT` (2).

## Verified
- Backend `npm test` 162 pass; frontend `npm test` + `vite build` pass.
- Against a local Postgres with all migrations: approve → new tenant + owner + 7-day trial + link (no password); second approve 409; link sets password, reuse rejected; login by phone works; forgot-password by phone goes to WhatsApp; dealer adds sub-dealer (link, no password); trial expiry blocks dealer and sub-dealer (dashboard 402); assigning a lead to an unpaid dealer refused, to a paid one works + WhatsApp alert; dealer sees lead with details; hands to sub-dealer, who sees it. Conversion script dry run and apply (bug found and fixed: invite-created sub-dealers are excluded).
- Not verified: real WhatsApp delivery, BullMQ worker run (trial logic unit-tested), RLS as the app DB user (local test ran as superuser).

## Open / outside code
- WhatsApp free text only reaches someone who messaged in the last 24 h. Trial reminders, dealer lead alerts and the welcome to an older joiner need the Meta templates under review.
- Razorpay payment link: needs account + KYC, not started.
- Plan after trial: dealer still on `multi_user_basic` until the super admin sets their paid plan (Admin → tenant → plan).

## Deploy
Backend: `git pull && npm ci && npm run migrate && pm2 restart all --update-env`. Frontend: pull, `npm ci`, `npm run build`, copy `dist/` to `/var/www/plotra-frontend/`.
