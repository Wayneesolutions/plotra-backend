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
