const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');

const { getFrontView, blurAllButProperty, focusMaskSvg, bearing, _cache } = require('../src/services/frontViewService');

// A 640x420 test "street photo": a sharp black/white checkerboard everywhere,
// so blur is easy to measure (a blurred checkerboard turns flat grey).
async function checkerboard() {
  const w = 640; const h = 420; const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
      px.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

// Contrast in a small window: high = sharp detail, near zero = blurred away.
async function contrastAt(jpeg, cx, cy, size = 24) {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  let min = 255; let max = 0;
  for (let y = cy - size / 2; y < cy + size / 2; y += 1) {
    for (let x = cx - size / 2; x < cx + size / 2; x += 1) {
      const v = data[y * info.width + x];
      if (v < min) min = v; if (v > max) max = v;
    }
  }
  return max - min;
}

test('only the centre (the property) stays sharp; edges, road and sky are blurred', async () => {
  const out = await blurAllButProperty(await checkerboard());
  const meta = await sharp(out).metadata();
  assert.strictEqual(meta.format, 'jpeg');
  assert.deepStrictEqual([meta.width, meta.height], [640, 420]);

  assert.ok(await contrastAt(out, 320, 190) > 150, 'centre should keep detail');
  for (const [x, y, where] of [[40, 200, 'left neighbour'], [600, 200, 'right neighbour'], [320, 380, 'road'], [320, 20, 'top'], [60, 60, 'corner']]) {
    assert.ok(await contrastAt(out, x, y) < 40, `${where} should be blurred`);
  }
});

test('focus mask is an oval centred on the property', () => {
  const svg = focusMaskSvg(640, 420).toString();
  assert.match(svg, /<ellipse cx="320" cy="193" rx="128" ry="126"/);
  assert.match(svg, /feGaussianBlur/);
});

test('bearing points from the street camera to the property', () => {
  assert.ok(Math.abs(bearing(30.9, 75.85, 30.901, 75.85) - 0) < 0.5);   // property due north
  assert.ok(Math.abs(bearing(30.9, 75.85, 30.9, 75.851) - 90) < 0.5);   // due east
  assert.ok(Math.abs(bearing(30.9, 75.85, 30.899, 75.85) - 180) < 0.5); // due south
});

test('getFrontView fetches one fixed frame facing the property, then caches it', async () => {
  _cache.clear();
  const raw = await checkerboard();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, params: opts.params });
    if (url.endsWith('/metadata')) return { data: { status: 'OK', pano_id: 'PANO1', location: { lat: 30.9, lng: 75.85 } } };
    return { data: raw };
  };
  const img = await getFrontView({ listingId: 'L1', lat: '30.9010000', lng: '75.8500000', apiKey: 'k', fetchImpl });
  assert.ok(Buffer.isBuffer(img));
  assert.strictEqual(calls.length, 2);
  const photo = calls[1].params;
  assert.strictEqual(photo.pano, 'PANO1');
  assert.strictEqual(photo.heading, 0); // camera on the road south of the house, facing north at it
  assert.ok(photo.fov <= 60, 'narrow field of view keeps neighbours out');
  assert.strictEqual(photo.source, 'outdoor');

  await getFrontView({ listingId: 'L1', lat: '30.9010000', lng: '75.8500000', apiKey: 'k', fetchImpl });
  assert.strictEqual(calls.length, 2, 'second view served from cache, no extra Google call');
});

test('getFrontView returns null when there is no street imagery or no key', async () => {
  _cache.clear();
  let n = 0;
  const fetchImpl = async () => { n += 1; return { data: { status: 'ZERO_RESULTS' } }; };
  assert.strictEqual(await getFrontView({ listingId: 'L2', lat: 1, lng: 2, apiKey: 'k', fetchImpl }), null);
  assert.strictEqual(await getFrontView({ listingId: 'L2', lat: 1, lng: 2, apiKey: 'k', fetchImpl }), null);
  assert.strictEqual(n, 1, '"no imagery" is cached too');
  assert.strictEqual(await getFrontView({ listingId: 'L3', lat: 1, lng: 2, apiKey: null, fetchImpl }), null);
});

test('getStreetViewPano returns the panorama id and a heading toward the property, and caches it', async () => {
  const { getStreetViewPano, _panoCache } = require('../src/services/frontViewService');
  _panoCache.clear();
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls += 1;
    assert.match(url, /streetview\/metadata$/);
    assert.strictEqual(opts.params.source, 'outdoor');
    // Camera 0.001 degrees south of the property: it must face north (heading ~0).
    return { data: { status: 'OK', pano_id: 'PANO123', location: { lat: 30.9, lng: 75.85 } } };
  };
  const a = await getStreetViewPano({ listingId: 'l1', lat: 30.901, lng: 75.85, apiKey: 'k', fetchImpl });
  assert.deepStrictEqual(a, { panoId: 'PANO123', heading: 0 });
  await getStreetViewPano({ listingId: 'l1', lat: 30.901, lng: 75.85, apiKey: 'k', fetchImpl });
  assert.strictEqual(calls, 1, 'second call served from cache');
});

test('getStreetViewPano returns null with no imagery or no key, and never exposes coordinates', async () => {
  const { getStreetViewPano, _panoCache } = require('../src/services/frontViewService');
  _panoCache.clear();
  const none = async () => ({ data: { status: 'ZERO_RESULTS' } });
  assert.strictEqual(await getStreetViewPano({ listingId: 'l2', lat: 1, lng: 1, apiKey: 'k', fetchImpl: none }), null);
  assert.strictEqual(await getStreetViewPano({ listingId: 'l3', lat: 1, lng: 1, apiKey: '', fetchImpl: none }), null);
  const ok = async () => ({ data: { status: 'OK', pano_id: 'P', location: { lat: 1, lng: 1.001 } } });
  const v = await getStreetViewPano({ listingId: 'l4', lat: 1, lng: 1, apiKey: 'k', fetchImpl: ok });
  assert.deepStrictEqual(Object.keys(v).sort(), ['heading', 'panoId']);
});

test('sanitizeBlurRegions keeps valid areas, drops malformed ones, caps the count and wraps heading', () => {
  const { sanitizeBlurRegions, MAX_BLUR_REGIONS } = require('../src/services/frontViewService');
  assert.deepStrictEqual(sanitizeBlurRegions('nope'), []);
  assert.deepStrictEqual(sanitizeBlurRegions([
    { heading: 370.04, pitch: 5.55, width: 10, height: 6 },   // valid, heading wraps
    { heading: 10, pitch: 5, width: 1, height: 6 },           // too small
    { heading: 10, pitch: 120, width: 10, height: 6 },        // pitch out of range
    { heading: 'x', pitch: 5, width: 10, height: 6 },         // not a number
    null,
    { heading: '90', pitch: '-4', width: '12', height: '8' }, // numeric strings are fine
  ]), [
    { heading: 10, pitch: 5.6, width: 10, height: 6 },
    { heading: 90, pitch: -4, width: 12, height: 8 },
  ]);
  const many = Array.from({ length: 20 }, () => ({ heading: 1, pitch: 1, width: 5, height: 5 }));
  assert.strictEqual(sanitizeBlurRegions(many).length, MAX_BLUR_REGIONS);
});

test('saved blur areas apply only to the panorama they were drawn on', () => {
  const { blurRegionsForPano } = require('../src/services/frontViewService');
  const saved = { panoId: 'PANO_A', regions: [{ heading: 10, pitch: 0, width: 10, height: 6 }] };
  assert.strictEqual(blurRegionsForPano(saved, 'PANO_A').length, 1);
  assert.deepStrictEqual(blurRegionsForPano(saved, 'PANO_B'), [], 'location changed, so the view changed: areas ignored');
  assert.deepStrictEqual(blurRegionsForPano(null, 'PANO_A'), []);
});

test('savedPanoView keeps the panorama the blur was drawn on while the pin is unchanged', () => {
  const { savedPanoView } = require('../src/services/frontViewService');
  const saved = { panoId: 'abc', heading: 123.4, lat: 30.9, lng: 75.85, regions: [] };
  assert.deepEqual(savedPanoView(saved, '30.900000', 75.85), { panoId: 'abc', heading: 123 });
  assert.equal(savedPanoView(saved, 30.9005, 75.85), null, 'pin moved');
  assert.equal(savedPanoView({ panoId: 'abc', regions: [] }, 30.9, 75.85), null, 'older saves without heading/coords');
  assert.equal(savedPanoView(null, 30.9, 75.85), null);
});

// ---- Fixed front photo with baked blur (21 Oct QA, option A) ----------------
const fvs = require('../src/services/frontViewService');

async function checkerboard640x480() {
  const w = 640; const h = 480; const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
      px.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test('bugs 1-3: boxes are baked into the photo, everything else stays sharp', async () => {
  const out = await fvs.bakeBlurRects(await checkerboard640x480(), [{ x: 0.25, y: 0.25, w: 0.25, h: 0.25 }]);
  const meta = await sharp(out).metadata();
  assert.deepStrictEqual([meta.format, meta.width, meta.height], ['jpeg', 640, 480]);
  assert.ok(await contrastAt(out, 240, 180) < 60, 'inside the box is blurred');
  assert.ok(await contrastAt(out, 500, 360) > 150, 'outside the box keeps detail');
  assert.ok(await contrastAt(out, 80, 400) > 150, 'outside the box keeps detail');
});

test('photo boxes are clipped to the image; junk and extras dropped', () => {
  assert.deepStrictEqual(fvs.sanitizeBlurRects([{ x: -0.1, y: 0.9, w: 0.3, h: 0.5 }]), [{ x: 0, y: 0.9, w: 0.2, h: 0.1 }]);
  assert.deepStrictEqual(fvs.sanitizeBlurRects([{ x: 'a' }, null, { x: 0.5, y: 0.5, w: 0.001, h: 0.2 }]), []);
  assert.strictEqual(fvs.sanitizeBlurRects(Array.from({ length: 12 }, () => ({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }))).length, fvs.MAX_BLUR_REGIONS);
  assert.deepStrictEqual(fvs.sanitizeBlurRects('nope'), []);
});

test('old angle areas convert onto the photo (centre of view = centre of photo)', () => {
  const frame = { panoId: 'P', heading: 90, pitch: 0, fov: 90 };
  const r = fvs.regionToFrameRect({ heading: 90, pitch: 0, width: 10, height: 10 }, frame);
  assert.ok(Math.abs(r.x + r.w / 2 - 0.5) < 0.01 && Math.abs(r.y + r.h / 2 - 0.5) < 0.01);
  // 10 degrees wide at fov 90: tan(5°) * f / W ≈ 0.0875 of the width each side
  assert.ok(Math.abs(r.w - 0.0875) < 0.005, String(r.w));
  assert.strictEqual(fvs.regionToFrameRect({ heading: 270, pitch: 0, width: 10, height: 10 }, frame), null, 'behind the camera');
  assert.deepStrictEqual(fvs.blurRectsFor({ panoId: 'OTHER', rects: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }] }, frame), [], 'other panorama');
  assert.strictEqual(fvs.blurRectsFor({ panoId: 'P', regions: [{ heading: 90, pitch: 0, width: 10, height: 10 }] }, frame).length, 1);
});

test('frame uses the saved fov/pitch so old boxes keep lining up', () => {
  const f = fvs.frameFor({ panoId: 'P', heading: 12.4 }, { frame: { fov: 55, pitch: 3 } });
  assert.deepStrictEqual(f, { panoId: 'P', heading: 12, fov: 55, pitch: 3 });
  assert.strictEqual(fvs.frameFor(null), null);
  assert.notStrictEqual(fvs.frontPhotoVersion(f, []), fvs.frontPhotoVersion(f, [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }]));
});

test('fetchFrontFrame asks Google for one fixed frame and caches it', async () => {
  fvs._frameCache.clear();
  const calls = [];
  const raw = await checkerboard640x480();
  const fetchImpl = async (url, opts) => { calls.push(opts.params); return { data: raw }; };
  const frame = { panoId: 'P1', heading: 45, pitch: 8, fov: 70 };
  const a = await fvs.fetchFrontFrame({ frame, apiKey: 'k', fetchImpl });
  const b = await fvs.fetchFrontFrame({ frame, apiKey: 'k', fetchImpl });
  assert.ok(Buffer.isBuffer(a) && a.equals(b));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([calls[0].pano, calls[0].heading, calls[0].fov, calls[0].size], ['P1', 45, 70, '640x480']);
  const notFound = async () => { const e = new Error('404'); e.response = { status: 404 }; throw e; };
  assert.strictEqual(await fvs.fetchFrontFrame({ frame: { ...frame, panoId: 'NONE' }, apiKey: 'k', fetchImpl: notFound }), null);
});
