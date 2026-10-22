# WhatsApp templates (22 Oct 2026)

Free text only reaches a number that messaged Plotraa in the last 24 hours. Everything below goes to people who often have NOT, so it is sent as a **template**. The outbound worker sends free text instead while the person's 24h window is open, and the template otherwise (`templateMode: auto`). If Meta rejects a template (not created yet, wrong variable count) the worker tries free text once; the failure is recorded either way in `whatsapp_template_sends` (Admin API: `GET /api/v1/admin/whatsapp-template-sends?status=failed`).

The variable count is checked in code before sending (`assertParamCount`) and in `test/billingTemplates.test.js`: **the text you submit to Meta must have exactly this many `{{n}}` variables, numbered 1..n.**

## New templates to create in Meta Business Manager

Language: `en` (override with `WA_TPL_LANG`, or `<ENV>_LANG` per template). Category: Utility (password reset can be Authentication if Meta insists). Names can be overridden with the env var in the table.

| Env var | Default name | Variables | Where it is sent |
|---|---|---|---|
| `WA_TPL_DEALER_WELCOME` | `plotraa_dealer_welcome` | 4 ({{1}} name, {{2}} trial_end_date, {{3}} login_id, {{4}} set_password_link) | Admin approves a WhatsApp joiner (welcome + set-password link) |
| `WA_TPL_SUBDEALER_INVITE` | `plotraa_subdealer_invite` | 4 ({{1}} name, {{2}} dealer_name, {{3}} login_id, {{4}} set_password_link) | Dealer adds a sub-dealer (Team -> Invite) |
| `WA_TPL_PASSWORD_RESET` | `plotraa_password_reset` | 2 ({{1}} reset_link, {{2}} valid_minutes) | Forgot password with a phone number |
| `WA_TPL_TRIAL_REMINDER` | `plotraa_trial_reminder` | 4 ({{1}} name, {{2}} time_left, {{3}} trial_end_date, {{4}} pay_link_or_hint) | Hourly trial job: 2 days and 1 day left |
| `WA_TPL_TRIAL_EXPIRED` | `plotraa_trial_expired` | 3 ({{1}} name, {{2}} trial_end_date, {{3}} pay_link_or_hint) | Hourly trial job: trial ended |
| `WA_TPL_PAYMENT_RECEIVED` | `plotraa_payment_received` | 2 ({{1}} name, {{2}} plan_label) | Razorpay payment_link.paid webhook |
| `WA_TPL_LEAD_ASSIGNED` | `plotraa_lead_assigned` | 4 ({{1}} dealer_name, {{2}} lead_name, {{3}} lead_phone, {{4}} lead_details) | Admin assigns a seller lead to a dealer; dealer hands a lead to a sub-dealer |

### Text to submit

**plotraa_dealer_welcome** (UTILITY)

```
Welcome to Plotraa, {{1}}! Your dealer account is approved and your free trial runs till {{2}}. Login ID: {{3}}. Set your password here (one-time link, valid 7 days): {{4}}. Then send your first property details on this chat.
```

**plotraa_subdealer_invite** (UTILITY)

```
Hello {{1}}, {{2}} has added you as a sub-dealer on Plotraa. Login ID: {{3}}. Set your password here (one-time link, valid 7 days): {{4}}. You can send property details on this chat to create listings.
```

**plotraa_password_reset** (AUTHENTICATION_OR_UTILITY)

```
Your Plotraa password reset link: {{1}} . It is valid for {{2}} minutes. If you did not ask for it, ignore this message.
```

**plotraa_trial_reminder** (UTILITY)

```
Hello {{1}}, your Plotraa free trial ends in {{2}} (on {{3}}). To keep adding listings, choose a plan and pay: {{4}}
```

**plotraa_trial_expired** (UTILITY)

```
Hello {{1}}, your Plotraa free trial ended on {{2}}. New listings are paused until you pay; your existing listings stay live. Pay here: {{3}}
```

**plotraa_payment_received** (UTILITY)

```
Hello {{1}}, we received your Plotraa payment for the {{2}} plan. Thank you! Your plan is active and new listings and leads are switched on.
```

**plotraa_lead_assigned** (UTILITY)

```
Hello {{1}}, new Plotraa lead: {{2}} ({{3}}). Details: {{4}}. Please contact them soon. It is also in the Leads section of your panel.
```

Give Meta a sample value for each variable when submitting (for example {{1}} = Rajesh, {{2}} = 28 Oct, {{3}} = +919876543210, {{4}} = https://plotraa.com/reset-password?token=abc).

## The 3 templates that already existed: variable counts, read from the code

Compare these with what is approved in Meta Business Manager. A template with a different number of variables is rejected by Meta (error 132000) and the message is never delivered.

| Env var | Variables in the code | Filled by |
|---|---|---|
| `SUPPORT_ALERT_TEMPLATE_NAME` | 3 body | `src/services/supportRequestService.js (supportAlertParams)` |
| `WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME` | 3 body + 1 quick-reply button | `src/services/callEnquiryService.js (buildTemplateJob)` |
| `WHATSAPP_REENGAGEMENT_TEMPLATE_NAME` | 1 body | `src/workers/whatsappOutboundWorker.js (window-closed branch)` |

- **support alert** (`SUPPORT_ALERT_TEMPLATE_NAME`): `{{1}}` who (audience, name, business), `{{2}}` phone, `{{3}}` what they need.
- **call enquiry** (`WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME`): `{{1}}` buyer name, `{{2}}` number of matching properties, `{{3}}` requirement; plus ONE quick-reply button (its payload is `call_enquiry:<id>`).
- **re-engagement** (`WHATSAPP_REENGAGEMENT_TEMPLATE_NAME`, per tenant `tenant_configs.whatsapp_reengagement_template_name`): `{{1}}` property title or lead name.

The support-alert and call-enquiry sends now carry `expectedParams`, so the worker refuses (and logs) a send whose variable count does not match, instead of burning three retries on a message Meta will reject.

## Checking what happened to a send

`GET /api/v1/admin/whatsapp-template-sends` lists every template send: template, phone, variables, `meta_message_id` (the wamid Meta returned), status (`queued` -> `sent` -> `delivered` -> `read`, or `failed`) and `error`. Meta's delivery receipts (`statuses` in the inbound webhook) update the same row, so a template Meta accepted but could not deliver shows `failed` with Meta's reason. Make sure the WhatsApp webhook subscription includes the **messages** field (it carries statuses too).

`GET /api/v1/admin/whatsapp-templates` returns this registry (names as configured, variable counts, text).
