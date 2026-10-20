// src/services/frontViewService.js
//
// "Front view" of a live listing: one still photo taken from the street,
// facing the property, with everything except the property blurred.
//
// Why a still photo and not the interactive Street View: Google's panorama
// can always be dragged/rotated, and an overlay can only cover part of it,
// so buyers could still look around the street. Here the server fetches a
// single fixed frame (narrow field of view, pointed at the house), blurs it
// everywhere except a soft oval on the house, and sends only that JPEG. The
// raw photo, the exact coordinates and our Google API key never reach the
// browser.

const axios = require('axios');
const sharp = require('sharp');

const WIDTH = 640;
const HEIGHT = 420;
// Narrow field of view = zoomed in on the house, neighbours mostly out of frame.
const FOV = Number(process.env.FRONT_VIEW_FOV) || 50;
const PITCH = 6;
// The sharp area: an oval in the middle where the house is.
const FOCUS = { cx: 0.5, cy: 0.46, rx: 0.2, ry: 0.3 };
const BLUR_SIGMA = 26;

// Small in-process cache so a popular link doesn't call Google on every
// view (each Street View Static request is billed).
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map(); // key -> { at, buffer | null }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return hit.buffer;
}
function cacheSet(key, buffer) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), buffer });
}

function bearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Pure (unit-tested): the feathered oval mask as SVG. */
function focusMaskSvg(width = WIDTH, height = HEIGHT, focus = FOCUS) {
  const feather = Math.round(Math.min(width, height) * 0.05);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${feather}"/></filter></defs>
      <ellipse cx="${Math.round(width * focus.cx)}" cy="${Math.round(height * focus.cy)}" rx="${Math.round(width * focus.rx)}" ry="${Math.round(height * focus.ry)}" fill="#fff" filter="url(#f)"/>
    </svg>`,
  );
}

function attributionSvg(width = WIDTH, height = HEIGHT) {
  // Google's attribution must stay visible on Street View imagery.
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect x="${width - 118}" y="${height - 22}" width="112" height="16" rx="3" fill="rgba(0,0,0,0.45)"/>
      <text x="${width - 62}" y="${height - 10}" font-family="Arial, sans-serif" font-size="11" fill="#fff" text-anchor="middle">Imagery © Google</text>
    </svg>`,
  );
}

/**
 * Pure image step (unit-tested): takes the raw street photo, returns a JPEG
 * where only the centre oval is sharp.
 */
async function blurAllButProperty(rawImage, { width = WIDTH, height = HEIGHT } = {}) {
  const base = sharp(rawImage).resize(width, height, { fit: 'cover' });
  const original = await base.clone().png().toBuffer();

  const blurred = await sharp(original)
    .blur(BLUR_SIGMA)
    .modulate({ brightness: 0.8, saturation: 0.55 })
    .png()
    .toBuffer();

  // Keep the original only where the mask is white.
  const sharpCentre = await sharp(original)
    .ensureAlpha()
    .composite([{ input: focusMaskSvg(width, height), blend: 'dest-in' }])
    .png()
    .toBuffer();

  return sharp(blurred)
    .composite([{ input: sharpCentre }, { input: attributionSvg(width, height) }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

/**
 * Builds the front view for a listing. Returns a JPEG Buffer, or null when
 * there's no Street View coverage near the property (caller hides the
 * section). Throws only on unexpected errors.
 */
async function getFrontView({ listingId, lat, lng, apiKey, fetchImpl = axios.get }) {
  if (!apiKey || lat == null || lng == null) return null;
  const nLat = Number(lat);
  const nLng = Number(lng);
  const key = `${listingId}:${nLat.toFixed(6)},${nLng.toFixed(6)}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // Where Google's camera actually stood (nearest road), so we can point it
  // at the property instead of down the street.
  const meta = await fetchImpl('https://maps.googleapis.com/maps/api/streetview/metadata', {
    params: { location: `${nLat},${nLng}`, radius: 60, source: 'outdoor', key: apiKey },
    timeout: 8000,
  });
  if (meta.data?.status !== 'OK' || !meta.data?.location) {
    cacheSet(key, null);
    return null;
  }
  const { lat: camLat, lng: camLng } = meta.data.location;
  const heading = Math.round(bearing(camLat, camLng, nLat, nLng));

  const img = await fetchImpl('https://maps.googleapis.com/maps/api/streetview', {
    params: {
      size: `${WIDTH}x${HEIGHT}`,
      ...(meta.data.pano_id ? { pano: meta.data.pano_id } : { location: `${camLat},${camLng}` }),
      heading,
      pitch: PITCH,
      fov: FOV,
      source: 'outdoor',
      return_error_code: true,
      key: apiKey,
    },
    responseType: 'arraybuffer',
    timeout: 10000,
  });

  const out = await blurAllButProperty(Buffer.from(img.data));
  cacheSet(key, out);
  return out;
}

// ---- Live street view (look around the house, no walking away) -----------
//
// Buyers get Google's interactive panorama locked to the one camera spot that
// faces the property (the page loads it by panorama id and heading; it never
// receives the property's own coordinates). The browser stops them walking
// down the street and limits how far they can turn, so they can look up,
// down and along the front of the house but not around the neighbourhood.
// Street View *metadata* requests are free; the result is cached per listing.
const panoCache = new Map(); // key -> { at, value | null }

function panoCacheGet(key) {
  const hit = panoCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { panoCache.delete(key); return undefined; }
  return hit.value;
}
function panoCacheSet(key, value) {
  if (panoCache.size >= CACHE_MAX) panoCache.delete(panoCache.keys().next().value);
  panoCache.set(key, { at: Date.now(), value });
}

/**
 * Returns { panoId, heading } for the panorama nearest the property, with the
 * heading pointing at the property, or null when Google has no outdoor
 * imagery within 60 m.
 */
async function getStreetViewPano({ listingId, lat, lng, apiKey, fetchImpl = axios.get }) {
  if (!apiKey || lat == null || lng == null) return null;
  const nLat = Number(lat);
  const nLng = Number(lng);
  const key = `${listingId}:${nLat.toFixed(6)},${nLng.toFixed(6)}`;
  const cached = panoCacheGet(key);
  if (cached !== undefined) return cached;

  const meta = await fetchImpl('https://maps.googleapis.com/maps/api/streetview/metadata', {
    params: { location: `${nLat},${nLng}`, radius: 60, source: 'outdoor', key: apiKey },
    timeout: 8000,
  });
  if (meta.data?.status !== 'OK' || !meta.data?.pano_id || !meta.data?.location) {
    panoCacheSet(key, null);
    return null;
  }
  const value = {
    panoId: meta.data.pano_id,
    heading: Math.round(bearing(meta.data.location.lat, meta.data.location.lng, nLat, nLng)),
  };
  panoCacheSet(key, value);
  return value;
}

module.exports = { getFrontView, getStreetViewPano, blurAllButProperty, focusMaskSvg, bearing, _cache: cache, _panoCache: panoCache };
