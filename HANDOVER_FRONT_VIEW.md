# Handover: still, blurred front view for live listings

Replaces the 18 Oct blur (frontend #41), which put a blur layer over the live Street View: buyers could still rotate/move it and see the street through the clear circle.

## What buyers see now (live listings)
- **One still photo** of the property's front, taken from the street and pointed at the house (narrow field of view), with **everything else blurred and dimmed**: neighbours, road, vehicles, signboards. No Street View, no rotating, no moving, no zoom.
- Made on the **server** (`src/services/frontViewService.js`, using `sharp`): Google Street View Static API → blur all but a soft oval on the house → JPEG. The browser only ever gets the blurred JPEG.
- The live listing API (`GET /public/listings/:slug`) **no longer sends exact lat/lng or the raw satellite/street image URLs** (those also contained our Google API key). It sends `frontViewUrl` instead.
- Before approval nothing changes: the dealer still gets the movable satellite + Street View to check and drag the pin.
- No Street View coverage near the property → the section is simply hidden.

## Backend
- New: `src/services/frontViewService.js`, `GET /api/v1/public/listings/:slug/front-view.jpg` (live listings only, 404 otherwise), `test/frontViewService.test.js`.
- Changed: `publicListingController.js` (strip coords/raw image URLs for live listings, add `frontViewUrl`), `routes/public.js`, `package.json` (+ `sharp`).
- Cost: 2 Google calls (metadata + 1 static image) per listing per 6h per server process (in-memory cache). Street View Static API must be enabled on `GOOGLE_MAPS_API_KEY` (it already is: the old static street image used it).
- Optional env: `FRONT_VIEW_FOV` (default 50; lower = tighter on the house).

## Frontend
- `PropertyView.jsx`: live listings show the front-view `<img>` ("🏠 Front view · surroundings hidden"); Street View only before approval. `PropertyMapMedia.jsx` back to its pre-#41 version (overlay code removed).

## Deploy
Backend: `git pull && npm ci && pm2 restart all --update-env` (`npm ci` installs `sharp`; no migration). Then rebuild + deploy the frontend.

## Verified
- Unit tests (`npm test`): blur measured on a test image (centre sharp; edges, road and top blurred), camera heading, one fixed frame with narrow FOV, caching, no imagery → null.
- Against Postgres: live listing API has no coords, no image URLs, no API key, and has `frontViewUrl`; preview listing unchanged; endpoint returns a 640x420 JPEG with cache headers, second view served from cache; non-live/unknown → 404.
- Frontend `vite build`; live page rendered in headless Chromium at phone width: still photo shown, zero calls to Google Maps from the browser.

## Not verified / known limits
- Not seen on a real Google photo yet. The camera stands on the nearest road, so in some photos the house may sit a little off-centre and part of it fall in the blur. Tune `FRONT_VIEW_FOV` or the oval (`FOCUS` in `frontViewService.js`).
- The house itself (including any house number painted on it) stays visible, by design.
- Google Maps Platform terms restrict modifying and caching Google imagery. Blurring parts of the photo and the 6h cache may not be fully compliant; worth checking before scaling. The fallback would be using the dealer's own front photo instead.
