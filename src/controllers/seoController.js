/**
 * Public, crawler-readable pages served by the API (nginx forwards these
 * paths here — see plotra-frontend/deploy/nginx-plotraa.conf):
 *
 *   GET /blog                 server-rendered blog list
 *   GET /blog/:slug           server-rendered post, real 404 if missing
 *   GET /sitemap.xml          static pages + every blog post
 *   GET /indexnow-<key>.txt   IndexNow key file
 *
 * When FRONTEND_DIST_DIR is set, /blog pages are served to everyone (the
 * HTML is the React shell + the article, and React takes over in the
 * browser). Without it, only known crawlers get the rendered HTML and
 * browsers fall through to whatever served the SPA before (old behaviour).
 */

const {
  loadTemplate,
  templateVersion,
  renderBlogPostPage,
  renderBlogListPage,
  render404Page,
  buildSitemapXml,
  cached,
  remember,
} = require('../services/seoPages');
const { isValidSlug } = require('../utils/blogContent');
const { indexNowKey } = require('../services/indexNowService');
const { isCrawler } = require('../utils/crawlers');

const LIST_COLUMNS = ['id', 'slug', 'title', 'meta_title', 'meta_description', 'tags', 'image_url', 'created_at', 'updated_at'];

function sendHtml(res, status, html) {
  res.status(status);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', status === 200 ? 'public, max-age=300' : 'no-store');
  return res.send(html);
}

/** Template if configured, else null (crawler-only mode). */
function templateFor(req) {
  const template = loadTemplate();
  if (template) return { template, mode: 'full' };
  if (isCrawler(req.headers['user-agent'])) return { template: null, mode: 'crawler' };
  return null;
}

async function serveBlogPostPage(req, res, next) {
  const t = templateFor(req);
  if (!t) return next();

  const slug = String(req.params.slug || '').toLowerCase();
  if (!isValidSlug(slug)) return sendHtml(res, 404, render404Page());

  const key = `post:${t.mode}:${templateVersion()}:${slug}`;
  const hit = cached(key);
  if (hit) return sendHtml(res, hit.status, hit.html);

  const knex = req.app.get('db');
  try {
    const post = await knex('blog_posts').where({ slug }).first();
    if (!post) {
      // short cache so a post published a moment later shows up quickly
      remember(key, { status: 404, html: render404Page() }, 60 * 1000);
      return sendHtml(res, 404, render404Page());
    }
    const related = await knex('blog_posts')
      .select(LIST_COLUMNS)
      .whereNot({ slug })
      .orderBy('created_at', 'desc')
      .limit(3);
    const html = renderBlogPostPage(post, related, { template: t.template });
    remember(key, { status: 200, html });
    return sendHtml(res, 200, html);
  } catch (error) {
    console.error('[seo] blog post render failed:', error.message);
    return next();
  }
}

async function serveBlogListPage(req, res, next) {
  // Tag filters / later pages are client-side views of the same list.
  if (req.query.tag || (req.query.page && req.query.page !== '1')) {
    const template = loadTemplate();
    return template ? sendHtml(res, 200, template) : next();
  }

  const t = templateFor(req);
  if (!t) return next();

  const key = `list:${t.mode}:${templateVersion()}`;
  const hit = cached(key);
  if (hit) return sendHtml(res, 200, hit);

  const knex = req.app.get('db');
  try {
    const limit = 12;
    const [{ count }] = await knex('blog_posts').count('* as count');
    const posts = await knex('blog_posts').select(LIST_COLUMNS).orderBy('created_at', 'desc').limit(limit);
    const tagRows = await knex.raw(
      'SELECT t AS tag, count(*)::int AS count FROM blog_posts, unnest(tags) AS t GROUP BY t ORDER BY count(*) DESC, t ASC LIMIT 40',
    );
    const list = {
      posts,
      tags: tagRows.rows.map((r) => r.tag),
      pagination: { page: 1, limit, total: Number(count), pages: Math.max(1, Math.ceil(Number(count) / limit)) },
    };
    return sendHtml(res, 200, remember(key, renderBlogListPage(list, { template: t.template })));
  } catch (error) {
    console.error('[seo] blog list render failed:', error.message);
    return next();
  }
}

async function serveSitemap(req, res) {
  const hit = cached('sitemap');
  const send = (xml) => {
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=900');
    return res.send(xml);
  };
  if (hit) return send(hit);

  const knex = req.app.get('db');
  try {
    const posts = await knex('blog_posts').select('slug', 'created_at', 'updated_at').orderBy('created_at', 'desc');
    return send(remember('sitemap', buildSitemapXml(posts)));
  } catch (error) {
    console.error('[seo] sitemap failed:', error.message);
    // Still return the static pages rather than an error.
    return send(buildSitemapXml([]));
  }
}

function serveIndexNowKey(req, res, next) {
  const key = indexNowKey();
  if (!key || req.params[0] !== key) return next();
  res.set('Content-Type', 'text/plain; charset=utf-8');
  return res.send(key);
}

module.exports = { serveBlogPostPage, serveBlogListPage, serveSitemap, serveIndexNowKey };
