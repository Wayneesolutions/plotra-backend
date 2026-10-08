# AI call enquiry → WhatsApp listings

A buyer phones the Plotraa number, the AI takes the requirement, and the buyer gets matching listings on WhatsApp. The enquiry shows up in the dashboard.

## Flow

1. Buyer calls. The call reaches WayneRing's inbound assistant (Vapi), running the property enquiry script.
2. The assistant collects buy/rent, type, area, budget, size, timeline, name, and a WhatsApp number it reads back and confirms.
3. Call ends. WayneRing posts `call.completed` to `POST /api/v1/webhooks/wayne-ring`. The poller (`worker-wayneRing`, every 2 min) is the fallback.
4. `wayneRingSyncService.syncInboundCalls` resolves the call:
   - dealer's own number (`tenant_configs.wayne_ring_inbound_number_id`): lead + `ai_voice_calls` row, as before
   - shared Plotraa line (`WAYNERING_PLATFORM_INBOUND_NUMBER_IDS`): no tenant
   - anything else: `wayne_ring_unmatched_calls`, as before
5. `callEnquiryService.processCallEnquiry` reads the transcript (gpt-4o-mini), matches active listings, writes a `call_enquiries` row and queues the WhatsApp template.
6. Buyer taps **Show properties** (or replies "yes" / "haan ji"). `webhookController` calls `handleCallEnquiryReply`, which sends the listing links as a normal message and logs `marketplace_lead_deliveries`.

Step 6 exists because the buyer phoned and never messaged, so no 24h service window is open. Meta accepts only an approved template as the first message, and template variables cannot contain line breaks, so the list of links cannot go in the template.

Matching scope: a call on the shared line searches every dealer's active listings. A call on a dealer's own number searches that dealer's listings only.

## Setup

### 1. WayneRing (aivoicebackend)

Needs branch `feature/property-enquiry-inbound` deployed. It adds the property enquiry script and fixes inbound transcripts being saved empty. Without the transcript fix, extraction only has the call summary to work from and will usually miss the WhatsApp number.

Logged in as Plotra's WayneRing tenant:

```bash
# import the number that receives the calls (Twilio shown)
POST /api/inbound/phone-numbers/import
{ "phoneNumber": "+1XXXXXXXXXX", "twilioSid": "PNxxxx", "provider": "twilio", "country": "CA" }
# -> note the returned "id": this is the phoneNumberId used below

# create the assistant; businessType "property_enquiry" selects the script
POST /api/inbound/assistants
{ "agentName": "Simran", "language": "hinglish", "agentGender": "female",
  "businessName": "Plotraa", "businessType": "property_enquiry", "maxCallDuration": 300 }

POST /api/inbound/assistants/<assistantId>/activate
{ "phoneNumberId": "<id from the import>" }

# push call results to Plotra
PATCH /api/tenant/webhook
{ "webhookUrl": "https://<plotra-api>/api/v1/webhooks/wayne-ring", "webhookSecret": "<random>" }
POST /api/tenant/webhook/test
```

### 2. Meta: approve the template

Category Utility, language English (or add more languages and set `WHATSAPP_CALL_ENQUIRY_TEMPLATE_LANG`).

```
Name:   call_enquiry_listings
Body:   Hi {{1}}, thanks for calling Plotraa. We found {{2}} matching properties for {{3}}. Tap below to see them.
Button: Quick reply — "Show properties"
```

`{{1}}` name (or "there"), `{{2}}` match count, `{{3}}` requirement, e.g. "200 gaj Plot in Sarabha Nagar".

### 3. Plotra env

```
WAYNERING_BASE_URL=            # these three were missing in production — the poller
WAYNERING_EMAIL=               # skips every tick until they are set
WAYNERING_PASSWORD=
WAYNERING_WEBHOOK_SECRET=<same secret as step 1>
WAYNERING_PLATFORM_INBOUND_NUMBER_IDS=<phoneNumberId of the shared Plotraa line>
WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME=call_enquiry_listings
WHATSAPP_CALL_ENQUIRY_TEMPLATE_LANG=en
CALL_FORWARDING_SOURCE_NUMBERS=<the Indian number(s) that forward to the AI line>
```

For a dealer's own AI-calling number, do not add it to `WAYNERING_PLATFORM_INBOUND_NUMBER_IDS`. Set that dealer's `tenant_configs.wayne_ring_inbound_number_id` to the phoneNumberId instead.

### 4. Deploy

```bash
npm run migrate          # 20261008_01_call_enquiries
pm2 restart api worker-wayneRing worker-whatsapp
```

## Where to look

| What | Where |
|---|---|
| Dealer's enquiries | `GET /api/v1/dashboard/ops/call-enquiries` |
| All enquiries + count per status | `GET /api/v1/admin/call-enquiries?days=30&status=` |
| Raw call log | `GET /api/v1/dashboard/ops/calls` |

`whatsapp_status` values:

| Status | Meaning |
|---|---|
| `template_sent` | Template queued, waiting for the buyer to tap |
| `listings_sent` | Buyer replied, links sent |
| `no_match` | Requirement captured, no active listing matched |
| `no_whatsapp_number` | No usable number: nothing valid spoken, and caller ID missing or one of our own lines |
| `no_consent` | Caller declined WhatsApp |
| `not_an_enquiry` | Hang-up, wrong number, no conversation |
| `skipped_no_template` | Matched, but `WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME` is not set |
| `skipped_stale` | Call was older than `CALL_ENQUIRY_MAX_AGE_MINUTES` when first seen |
| `failed` | Could not queue the WhatsApp send |

## Known limits

- Listing match uses property type and area only, same as the WhatsApp marketplace search. Budget and size are stored and shown, not filtered on.
- With carrier call forwarding, the caller ID that reaches Vapi may be the forwarding line instead of the buyer. The script always asks for the WhatsApp number and reads it back; `CALL_FORWARDING_SOURCE_NUMBERS` stops us messaging our own line when it does not get one.
- WayneRing's `GET /api/inbound/calls` returns the newest 50 calls. Above roughly 50 inbound calls per 2-minute poll interval the poller alone would miss calls; the webhook covers this.
- A spoken number is accepted only if it is a valid 10-digit Indian mobile.
