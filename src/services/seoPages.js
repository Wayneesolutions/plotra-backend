/**
 * Server-rendered public pages for search engines and AI crawlers
 * (ChatGPT, Claude, Perplexity don't run JavaScript, so a client-rendered
 * page looks empty to them).
 *
 *  - /blog and /blog/:slug  → full HTML (title, meta, canonical, OG, JSON-LD,
 *    H1, article body, dates, related guides) injected into the frontend's
 *    SPA shell (FRONTEND_DIST_DIR/app.html), so browsers still get the React
 *    app — it takes over from window.__PLOTRAA_DATA__ without a refetch.
 *  - /sitemap.xml           → static pages + every blog post (lastmod).
 *
 * Rendered HTML is cached in memory for an hour and cleared whenever a post
 * is created / updated / deleted in the blog admin (clearSeoCache()).
 */

const fs = require('fs');
const path = require('path');

const SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://plotraa.com').replace(/\/$/, '');
const OG_IMAGE = `${SITE_URL}/og-image.jpg`;
const ORG_ID = `${SITE_URL}/#organization`;

// Used only if the frontend build's seo-routes.json can't be read.
const FALLBACK_STATIC_ROUTES = [
  '/', '/how-it-works', '/pricing', '/team', '/about', '/faq',
  '/features/whatsapp-property-listing', '/features/lead-management',
  '/property-dealer-software-ludhiana', '/property-dealer-software-mohali-kharar',
  '/plotraa-vs-property-portals', '/legal', '/blog', '/sell-property',
];

/* ------------------------------- helpers -------------------------------- */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const jsonForScript = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

const isoDate = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// Same format as the frontend's formatBlogDate ("18 November 2026").
const displayDate = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

function distDir() {
  return process.env.FRONTEND_DIST_DIR ? path.resolve(process.env.FRONTEND_DIST_DIR) : null;
}

/* ------------------------------- template ------------------------------- */

let templateCache = { file: null, mtimeMs: 0, html: null };

/** The frontend's empty SPA shell, or null when FRONTEND_DIST_DIR isn't set/readable. */
function loadTemplate() {
  const dir = distDir();
  if (!dir) return null;
  const file = fs.existsSync(path.join(dir, 'app.html')) ? path.join(dir, 'app.html') : path.join(dir, 'index.html');
  try {
    const { mtimeMs } = fs.statSync(file);
    if (templateCache.file !== file || templateCache.mtimeMs !== mtimeMs) {
      const html = fs.readFileSync(file, 'utf8');
      if (!/<title>[\s\S]*?<\/title>/.test(html) || !/<div id="root"[^>]*><\/div>/.test(html)) {
        console.error(`[seo] ${file} has no <title> or empty #root — not usable as a template`);
        return null;
      }
      templateCache = { file, mtimeMs, html };
    }
    return templateCache.html;
  } catch (err) {
    console.error('[seo] could not read frontend template:', err.message);
    return null;
  }
}

/** Minimal standalone document, used for crawlers when there is no template. */
const BARE_TEMPLATE = `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Plotraa</title>
</head>
<body>
<div id="root"></div>
</body>
</html>`;

function headTags({ title, description, path: pagePath, image, type = 'website', jsonLd = [], noindex = false }) {
  const url = `${SITE_URL}${pagePath}`;
  return [
    `<title>${esc(title)}</title>`,
    `<meta data-seo name="description" content="${esc(description)}">`,
    noindex ? '' : `<link data-seo rel="canonical" href="${esc(url)}">`,
    `<meta data-seo name="robots" content="${noindex ? 'noindex, follow' : 'index, follow'}">`,
    `<meta data-seo property="og:type" content="${type}">`,
    `<meta data-seo property="og:site_name" content="Plotraa">`,
    `<meta data-seo property="og:title" content="${esc(title)}">`,
    `<meta data-seo property="og:description" content="${esc(description)}">`,
    `<meta data-seo property="og:url" content="${esc(url)}">`,
    `<meta data-seo property="og:image" content="${esc(image || OG_IMAGE)}">`,
    `<meta data-seo name="twitter:card" content="summary_large_image">`,
    jsonLd.length
      ? `<script data-seo type="application/ld+json">${jsonForScript({ '@context': 'https://schema.org', '@graph': jsonLd })}</script>`
      : '',
  ]
    .filter(Boolean)
    .join('\n    ');
}

function fillTemplate(template, { head, body, data }) {
  return template
    .replace(/<title>[\s\S]*?<\/title>/, () => head)
    .replace(
      /<div id="root"[^>]*><\/div>/,
      () => `<div id="root">${body}</div>\n    <script>window.__PLOTRAA_DATA__=${jsonForScript(data || {})}</script>`,
    );
}

const NAV = `<header class="px-5 pt-5"><nav aria-label="Main"><a href="/">Plotraa</a> · <a href="/how-it-works">How it works</a> · <a href="/pricing">Pricing</a> · <a href="/blog">Blog</a> · <a href="/faq">FAQ</a></nav></header>`;
const FOOTER = `<footer class="px-5 py-10 text-sm"><p>Plotraa — a product of Wayne E Solutions · Model Town, Ludhiana, Punjab, India · WhatsApp: +91 93951 90000 · info@plotraa.com</p></footer>`;

/* -------------------------------- pages --------------------------------- */

function breadcrumb(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: `${SITE_URL}${it.path}` })),
  };
}

/**
 * @param post     full blog_posts row
 * @param related  up to 3 other posts (summary rows)
 * @param opts     { template } — pass null to use the bare crawler document
 */
function renderBlogPostPage(post, related = [], { template } = {}) {
  const { htmlToText } = require('../utils/blogContent');
  const pagePath = `/blog/${post.slug}`;
  const title = post.meta_title || `${post.title} | Plotraa`;
  const description = post.meta_description || htmlToText(post.description).slice(0, 160);
  const published = isoDate(post.created_at);
  const updated = isoDate(post.updated_at) || published;

  const jsonLd = [
    {
      '@type': 'BlogPosting',
      headline: post.title,
      description,
      url: `${SITE_URL}${pagePath}`,
      mainEntityOfPage: `${SITE_URL}${pagePath}`,
      ...(post.image_url ? { image: post.image_url } : {}),
      datePublished: published,
      dateModified: updated,
      ...(post.tags?.length ? { keywords: post.tags.join(', ') } : {}),
      author: { '@type': 'Organization', name: 'Plotraa', url: `${SITE_URL}/` },
      publisher: { '@id': ORG_ID },
      inLanguage: 'en-IN',
    },
    breadcrumb([
      { name: 'Home', path: '/' },
      { name: 'Blog', path: '/blog' },
      { name: post.title, path: pagePath },
    ]),
  ];

  const showUpdated = displayDate(post.updated_at) && displayDate(post.updated_at) !== displayDate(post.created_at);
  const relatedHtml = [
    ...related.map((r) => `<li><a href="/blog/${esc(r.slug)}">${esc(r.title)}</a></li>`),
    '<li><a href="/pricing">Plotraa pricing for property dealers</a></li>',
  ].join('');

  const body = `${NAV}
<main>
<article class="bg-background px-5 pb-20 pt-32 sm:px-8 sm:pt-40">
<div class="mx-auto max-w-3xl">
<p><a href="/blog">All posts</a></p>
<h1 class="mt-6 font-display text-4xl font-bold text-ink sm:text-5xl">${esc(post.title)}</h1>
<p class="mt-4 text-sm text-muted-foreground">By Plotraa Team · Published <time datetime="${esc(published)}">${esc(displayDate(post.created_at))}</time>${
    showUpdated ? ` · Updated <time datetime="${esc(updated)}">${esc(displayDate(post.updated_at))}</time>` : ''
  }</p>
${post.image_url ? `<img src="${esc(post.image_url)}" alt="${esc(post.title)}" class="mt-10 w-full rounded-3xl" />` : ''}
<div class="blog-prose mt-10">${post.description}</div>
<aside class="mt-14" aria-labelledby="related-guides"><h2 id="related-guides">Related guides</h2><ul>${relatedHtml}</ul></aside>
</div>
</article>
</main>
${FOOTER}`;

  return fillTemplate(template || BARE_TEMPLATE, {
    head: headTags({ title, description, path: pagePath, image: post.image_url, type: 'article', jsonLd }),
    body,
    data: { blogPost: post },
  });
}

function renderBlogListPage(list, { template } = {}) {
  const title = 'Plotraa Blog: Guides for Property Dealers and Buyers';
  const description =
    'Practical guides from Plotraa on listing property, pricing plots, checking paperwork and winning buyer leads on WhatsApp.';
  const jsonLd = [
    { '@type': 'Blog', url: `${SITE_URL}/blog`, name: 'Plotraa Blog', publisher: { '@id': ORG_ID } },
    breadcrumb([
      { name: 'Home', path: '/' },
      { name: 'Blog', path: '/blog' },
    ]),
  ];
  const items = list.posts
    .map(
      (p) => `<li><article><h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2><p><time datetime="${esc(
        isoDate(p.created_at),
      )}">${esc(displayDate(p.created_at))}</time></p>${p.meta_description ? `<p>${esc(p.meta_description)}</p>` : ''}</article></li>`,
    )
    .join('\n');
  const body = `${NAV}
<main class="px-5 pt-32">
<h1>Plotraa blog</h1>
<p>Guides for property dealers and buyers: listing, pricing, paperwork and getting more from WhatsApp.</p>
<ul>${items}</ul>
</main>
${FOOTER}`;
  return fillTemplate(template || BARE_TEMPLATE, {
    head: headTags({ title, description, path: '/blog', jsonLd }),
    body,
    data: { blogList: list },
  });
}

/** The frontend's prerendered 404 page, or a small fallback. */
function render404Page() {
  const dir = distDir();
  if (dir) {
    try {
      return fs.readFileSync(path.join(dir, '404.html'), 'utf8');
    } catch {
      // fall through
    }
  }
  return `<!DOCTYPE html><html lang="en-IN"><head><meta charset="UTF-8"><title>Page not found | Plotraa</title><meta name="robots" content="noindex, follow"></head><body><h1>Page not found</h1><p><a href="/">Home</a> · <a href="/pricing">Pricing</a> · <a href="/blog">Blog</a></p></body></html>`;
}

/* ------------------------------- sitemap -------------------------------- */

function staticRoutes() {
  const dir = distDir();
  if (dir) {
    try {
      const { routes } = JSON.parse(fs.readFileSync(path.join(dir, 'seo-routes.json'), 'utf8'));
      if (Array.isArray(routes) && routes.length) {
        return routes.map((r) => {
          let lastmod = null;
          try {
            const file = r === '/' ? path.join(dir, 'index.html') : path.join(dir, r.replace(/^\//, ''), 'index.html');
            lastmod = fs.statSync(file).mtime;
          } catch {
            // no file → no lastmod
          }
          return { path: r, lastmod };
        });
      }
    } catch {
      // fall back below
    }
  }
  return FALLBACK_STATIC_ROUTES.map((r) => ({ path: r, lastmod: null }));
}

function buildSitemapXml(posts) {
  const day = (d) => (isoDate(d) ? isoDate(d).slice(0, 10) : null);
  const statics = staticRoutes();
  const newestPost = posts.reduce((max, p) => (!max || new Date(p.updated_at) > max ? new Date(p.updated_at) : max), null);

  const urls = [
    ...statics.map((s) => ({
      loc: `${SITE_URL}${s.path === '/' ? '/' : s.path}`,
      lastmod: day(s.path === '/blog' && newestPost ? newestPost : s.lastmod),
    })),
    ...posts.map((p) => ({ loc: `${SITE_URL}/blog/${p.slug}`, lastmod: day(p.updated_at || p.created_at) })),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => `  <url>\n    <loc>${esc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}\n  </url>`)
  .join('\n')}
</urlset>
`;
}

/* -------------------------------- cache --------------------------------- */

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

function cached(key, ttlMs = CACHE_TTL_MS) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (hit) cache.delete(key);
  return undefined;
}

function remember(key, value, ttlMs = CACHE_TTL_MS) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

/** Changes whenever a new frontend build is deployed (cache key part). */
function templateVersion() {
  return `${templateCache.file || 'none'}:${templateCache.mtimeMs}`;
}

function clearSeoCache() {
  cache.clear();
}

module.exports = {
  SITE_URL,
  loadTemplate,
  templateVersion,
  renderBlogPostPage,
  renderBlogListPage,
  render404Page,
  buildSitemapXml,
  cached,
  remember,
  clearSeoCache,
};
