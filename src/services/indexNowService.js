/**
 * IndexNow — tells Bing (and through it ChatGPT search), Yandex, Seznam etc.
 * about new or changed URLs right away instead of waiting for a recrawl.
 *
 * Setup: put a key (8–128 chars, letters/digits/hyphens) in INDEXNOW_KEY.
 * The key file is served at https://plotraa.com/indexnow-<key>.txt by
 * controllers/seoController.js (nginx forwards /indexnow-* to the API).
 *
 * Never throws: a failed ping must not break saving a blog post.
 */

const axios = require('axios');
const { SITE_URL } = require('./seoPages');

const KEY_RE = /^[a-zA-Z0-9-]{8,128}$/;

function indexNowKey() {
  const key = (process.env.INDEXNOW_KEY || '').trim();
  return KEY_RE.test(key) ? key : null;
}

async function submitUrls(paths) {
  const key = indexNowKey();
  if (!key) return { skipped: true };
  const host = new URL(SITE_URL).host;
  const urlList = [...new Set(paths)].map((p) => (p.startsWith('http') ? p : `${SITE_URL}${p}`));
  if (!urlList.length) return { skipped: true };

  try {
    const res = await axios.post(
      'https://api.indexnow.org/indexnow',
      { host, key, keyLocation: `${SITE_URL}/indexnow-${key}.txt`, urlList },
      { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 8000 },
    );
    return { status: res.status };
  } catch (err) {
    console.error('[indexnow] submit failed:', err.response?.status || err.message);
    return { error: err.message };
  }
}

/** Fire-and-forget ping for a blog post change. */
function pingBlogPost(slug, previousSlug) {
  const paths = ['/blog', '/sitemap.xml', `/blog/${slug}`];
  if (previousSlug && previousSlug !== slug) paths.push(`/blog/${previousSlug}`);
  submitUrls(paths).catch(() => {});
}

module.exports = { indexNowKey, submitUrls, pingBlogPost };
