/**
 * Server-rendered blog pages, sitemap, IndexNow key file and the shared
 * crawler list (SEO / AI-search fix, Nov 2026). Uses a tiny in-memory stand
 * in for knex so it runs without Postgres.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const POSTS = [
  {
    id: '1', slug: 'whatsapp-crm-for-real-estate-india', title: 'WhatsApp CRM for Real Estate in India',
    meta_title: 'WhatsApp CRM for Real Estate in India | Plotraa', meta_description: 'List properties from WhatsApp.',
    description: '<p>Plotraa lets dealers list from WhatsApp.</p><h2>Why</h2><p>Because.</p>', tags: ['crm'],
    image_url: null, created_at: new Date('2026-11-12T06:00:00Z'), updated_at: new Date('2026-11-18T06:00:00Z'),
  },
  {
    id: '2', slug: 'best-crm-for-property-dealers-india', title: 'Best CRM for Property Dealers in India (2026 Guide)',
    meta_title: null, meta_description: null, description: '<p>Compare tools.</p>', tags: [],
    image_url: null, created_at: new Date('2026-11-10T06:00:00Z'), updated_at: new Date('2026-11-10T06:00:00Z'),
  },
];

/** Just enough of knex for seoController. */
function fakeKnex() {
  const k = (table) => {
    let rows = table === 'blog_posts' ? [...POSTS] : [];
    const q = {
      select() { return q; },
      where(obj) { rows = rows.filter((r) => Object.entries(obj).every(([key, v]) => r[key] === v)); return q; },
      whereNot(obj) { rows = rows.filter((r) => !Object.entries(obj).every(([key, v]) => r[key] === v)); return q; },
      orderBy() { rows.sort((a, b) => b.created_at - a.created_at); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      first() { return Promise.resolve(rows[0]); },
      count() { return Promise.resolve([{ count: String(rows.length) }]); },
      then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
    };
    return q;
  };
  k.raw = async () => ({ rows: [{ tag: 'crm', count: 1 }] });
  return k;
}

let server;
let base;
let distDir;

before(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plotraa-dist-'));
  fs.writeFileSync(
    path.join(distDir, 'app.html'),
    '<!DOCTYPE html><html><head><title>Plotraa — WhatsApp-native real estate CRM</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(path.join(distDir, '404.html'), '<!DOCTYPE html><html><head><title>Page not found | Plotraa</title></head><body><h1>Page not found</h1></body></html>');
  fs.writeFileSync(path.join(distDir, 'seo-routes.json'), JSON.stringify({ routes: ['/', '/pricing', '/faq', '/blog'] }));
  process.env.FRONTEND_DIST_DIR = distDir;
  process.env.INDEXNOW_KEY = 'abcd1234efgh5678';

  const app = require('../src/app');
  app.set('db', fakeKnex());
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

const get = (p, ua = 'Mozilla/5.0') => fetch(base + p, { headers: { 'user-agent': ua } });

test('blog post: full HTML with own title, canonical, H1, body and schema', async () => {
  const res = await get('/blog/whatsapp-crm-for-real-estate-india', 'OAI-SearchBot/1.0');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>WhatsApp CRM for Real Estate in India \| Plotraa<\/title>/);
  assert.match(html, /<link data-seo rel="canonical" href="https:\/\/plotraa.com\/blog\/whatsapp-crm-for-real-estate-india">/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /Plotraa lets dealers list from WhatsApp\./);
  assert.match(html, /"@type":"BlogPosting"/);
  assert.match(html, /"dateModified":"2026-11-18T06:00:00.000Z"/);
  assert.match(html, /Published <time/);
  assert.match(html, /Updated <time/);
  assert.match(html, /Related guides/);
  assert.match(html, /\/blog\/best-crm-for-property-dealers-india/);
  assert.match(html, /window.__PLOTRAA_DATA__=\{"blogPost":/);
  assert.match(html, /<script type="module" src="\/assets\/app.js">/, 'keeps the React bundle');
});

test('blog post: also served to normal browsers when the template is configured', async () => {
  const res = await get('/blog/best-crm-for-property-dealers-india');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Best CRM for Property Dealers in India \(2026 Guide\) \| Plotraa<\/title>/);
  assert.match(html, /<meta data-seo name="description" content="Compare tools.">/);
});

test('unknown blog slug → real 404 with the not-found page', async () => {
  const res = await get('/blog/this-post-does-not-exist');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Page not found/);
  const bad = await get('/blog/Not_A_Valid_Slug!!');
  assert.equal(bad.status, 404);
});

test('blog list lists every post title in the HTML', async () => {
  const res = await get('/blog', 'ClaudeBot/1.0');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1>Plotraa blog<\/h1>/);
  assert.match(html, /WhatsApp CRM for Real Estate in India/);
  assert.match(html, /Best CRM for Property Dealers in India/);
  assert.match(html, /"blogList":/);
});

test('sitemap: static routes + posts, no {slug} placeholders, xml content type', async () => {
  const res = await get('/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  const xml = await res.text();
  assert.doesNotMatch(xml, /\{slug\}/);
  assert.match(xml, /<loc>https:\/\/plotraa.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/plotraa.com\/faq<\/loc>/);
  assert.match(xml, /<loc>https:\/\/plotraa.com\/blog\/whatsapp-crm-for-real-estate-india<\/loc>\n    <lastmod>2026-11-18<\/lastmod>/);
  assert.doesNotMatch(xml, /request-access/);
});

test('IndexNow key file is served only for the configured key', async () => {
  const ok = await get('/indexnow-abcd1234efgh5678.txt');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'abcd1234efgh5678');
  const wrong = await get('/indexnow-zzzz1234zzzz5678.txt');
  assert.equal(wrong.status, 404);
});

test('crawler list includes the AI search bots', () => {
  const { isCrawler } = require('../src/utils/crawlers');
  for (const ua of ['OAI-SearchBot/1.0', 'ChatGPT-User/1.0', 'Claude-SearchBot', 'PerplexityBot/1.0', 'Mozilla/5.0 (compatible; bingbot/2.0)']) {
    assert.ok(isCrawler(ua), ua);
  }
  assert.equal(isCrawler('Mozilla/5.0 (Windows NT 10.0) Chrome/130'), false);
});

test('without FRONTEND_DIST_DIR, browsers fall through and crawlers still get HTML', () => {
  const { renderBlogPostPage } = require('../src/services/seoPages');
  const html = renderBlogPostPage(POSTS[0], [], { template: null });
  assert.match(html, /<h1[^>]*>WhatsApp CRM for Real Estate in India<\/h1>/);
  assert.match(html, /<title>WhatsApp CRM for Real Estate in India \| Plotraa<\/title>/);
});
