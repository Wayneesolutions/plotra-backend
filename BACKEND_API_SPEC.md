# Plotra Web Chat — Backend Endpoint Spec

> **Historical / superseded.** `POST /api/v1/chat/web` (and `/web/photo`)
> described below are built and live exactly as specified here. The static
> `plotra-web-chat.html` page this doc originally targeted has been
> **retired and deleted** — the widget now lives in `plotra-frontend` as
> `ChatWidget.jsx`, mounted at the `/widget` route (iframe-embeddable on a
> tenant's own site). It also now requires a per-tenant activation code
> (`POST /api/v1/chat/web/activate`, then `tenant_code` on every call) —
> see `HANDOVER.md` §1.4/§1.5. Kept below for the original endpoint
> contract, which hasn't changed.

The web chat page (`plotra-web-chat.html`) is fully built and functional on the
frontend. It POSTs to one endpoint that doesn't exist yet. This is the only
backend work needed to make it live.

## Why this is needed

The existing WhatsApp webhook
(`/api/v1/webhooks/whatsapp/inbound`) is one-way: Meta calls it, and any
reply goes back out through the WhatsApp Graph API — not back to whoever
made the original request. A browser can't use that endpoint directly,
because there's nothing for it to synchronously wait on.

This new endpoint should reuse the *same* address-parsing / listing-creation
logic the WhatsApp handler already calls — it's just a different transport
in front of the same business logic. If the WhatsApp handler calls something
like `createListingFromMessage(text, senderId)`, this endpoint should call
that same function.

## Endpoint to build

```
POST /api/v1/chat/web
```

### Request body

```json
{
  "message": "Hno 102 Lahri Nagar, Mundia Khurd, Chandigarh Road, Ludhiana",
  "session_id": "a random UUID generated per browser session, no login required"
}
```

### Response body (200 OK)

```json
{
  "reply": "Got it! I've mapped the address and created your listing.",
  "listing": {
    "title": "Lahri Nagar Plot — House No. 102",
    "address": "Mundia Khurd, Chandigarh Road, Ludhiana, Punjab"
  }
}
```

`listing` should be `null` if the message didn't result in a listing (e.g.
a greeting, a follow-up question, an incomplete address) — the frontend
just shows `reply` as plain text in that case.

### Error responses

Any non-2xx status is treated by the frontend as "backend unreachable" and
it automatically shows a WhatsApp fallback link to the visitor — so a
clean error status is enough, no special error body format is required.
A `500` with a JSON body containing `{"error": "..."}` is fine if you want
to log more detail server-side.

## Practical notes

- **CORS**: if the web chat page is hosted on a different origin than
  `plotra.wayneesolutions.com` (e.g. a separate marketing site or a
  Claude-published page), this endpoint needs
  `Access-Control-Allow-Origin` set appropriately, or the fetch will be
  blocked by the browser silently.
- **No auth required** for a first pass — this is meant to be public-facing,
  like the WhatsApp number is. Consider basic rate-limiting per `session_id`
  or IP to avoid abuse, but that's a hardening step, not a blocker for demo
  readiness.
- **Session/conversation state**: `session_id` is a random ID with no
  backing login. If multi-turn conversation memory matters (e.g.
  "reply with photos, price, or size" as a follow-up), key that state off
  `session_id` in memory or a short-lived store — don't require the
  visitor to log in.
- **Reuse, don't duplicate**: the whole point of this endpoint is to avoid
  writing new address-parsing/listing-creation logic — it should call
  the exact same internal function(s) the WhatsApp webhook handler uses,
  just triggered by a different transport (HTTP POST instead of a Meta
  webhook event).

## Once deployed

Superseded — see the note at the top of this doc. There's no config line
to update anymore: `ChatWidget.jsx` (plotra-frontend, `/widget` route)
calls `/api/v1/chat/web` via the same `apiClient` every other dashboard
call uses (`VITE_API_BASE_URL`), and identifies the tenant via the
activation code rather than a hardcoded endpoint override.
