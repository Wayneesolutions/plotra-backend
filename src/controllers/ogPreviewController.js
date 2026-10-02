/**
 * Serves OG meta tags for known social media / messaging crawlers hitting
 * /p/:slug. Real browsers call next() and get the SPA as normal.
 *
 * In dev: Vite's proxy config bypasses /p/* to index.html for non-crawlers
 * and forwards to this backend handler for crawlers.
 * In production: an Express static middleware (or nginx) serves index.html
 * for non-crawlers; this handler runs ahead of it and intercepts bots only.
 *
 * Test with:
 *   curl -A "facebookexternalhit/1.1" http://localhost:3001/p/<slug>
 */

const { htmlToText } = require('../utils/blogContent');

const KNOWN_CRAWLERS = [
  'facebookexternalhit',
  'WhatsApp',
  'Twitterbot',
  'Slackbot',
  'LinkedInBot',
  'TelegramBot',
  'Googlebot',
  'bingbot',
];

function isCrawler(userAgent = '') {
  return KNOWN_CRAWLERS.some((bot) => userAgent.includes(bot));
}

function buildOgHtml({ title, description, imageUrl, pageUrl, type = 'website', extraHead = '' }) {
  const safeTitle = title.replace(/"/g, '&quot;');
  const safeDesc = description.replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${safeTitle}</title>
  ${extraHead}
  <meta property="og:type" content="${type}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:url" content="${pageUrl}" />
  ${imageUrl ? `<meta property="og:image" content="${imageUrl}" />` : ''}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  ${imageUrl ? `<meta name="twitter:image" content="${imageUrl}" />` : ''}
</head>
<body></body>
</html>`;
}

async function servePropertyPreview(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (!isCrawler(ua)) return next();

  const knex = req.app.get('db');
  const { slug } = req.params;

  try {
    const listing = await knex('listings')
      .leftJoin('listing_media', 'listings.id', 'listing_media.listing_id')
      .select(
        'listings.title',
        'listings.formatted_address',
        'listings.raw_address',
        'listings.general_area',
        'listings.price',
        'listings.property_type',
        'listings.plot_area',
        'listings.description',
        'listing_media.satellite_image_url'
      )
      // 'awaiting_approval' included so the preview link sent to the agent
      // (see agentIntakeWorker.js) actually renders a rich WhatsApp card —
      // otherwise WhatsApp's own crawler would 404 on a listing that's
      // pending the agent's own approval.
      .where({ 'listings.public_slug': slug })
      .whereIn('listings.status', ['active', 'awaiting_approval'])
      .first();

    if (!listing) {
      return res.status(404).send('Not found');
    }

    // Same masking as PropertyView.jsx — general_area (locality-level) for
    // any listing that has one (new listings only; see the migration),
    // exact address unchanged for everything geocoded before this feature.
    const address = listing.general_area || listing.formatted_address || listing.raw_address;
    const priceFormatted = listing.price != null
      ? new Intl.NumberFormat('en-IN', {
          style: 'currency',
          currency: 'INR',
          maximumFractionDigits: 0,
        }).format(listing.price)
      : 'Price on request';

    const description =
      listing.description ||
      `${listing.property_type} — ${listing.plot_area || ''} | ${address} | ${priceFormatted}`.trim();

    const pageUrl = `${req.protocol}://${req.get('host')}/p/${slug}`;

    return res.status(200).send(
      buildOgHtml({
        title: listing.title,
        description,
        imageUrl: listing.satellite_image_url || null,
        pageUrl,
      })
    );
  } catch (error) {
    console.error('OG preview fetch failed:', error);
    return next(); // fallback: let SPA handle it rather than showing an error page
  }
}

/**
 * Crawler preview for /blog/:slug — meta title / meta description / image
 * exactly as entered in the blog admin panel, falling back to the post
 * title and the start of the body when the meta fields were left empty.
 *
 *   curl -A "facebookexternalhit/1.1" http://localhost:3001/blog/<slug>
 */
async function serveBlogPreview(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (!isCrawler(ua)) return next();

  const knex = req.app.get('db');
  const slug = String(req.params.slug || '').toLowerCase();

  try {
    const post = await knex('blog_posts')
      .select('title', 'meta_title', 'meta_description', 'description', 'image_url')
      .where({ slug })
      .first();

    if (!post) return res.status(404).send('Not found');

    const escapeText = (value) =>
      String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const description = escapeText(post.meta_description || htmlToText(post.description).slice(0, 160));
    // PUBLIC_APP_URL is the frontend's public address (already used for the
    // /p/:slug links sent over WhatsApp) — the canonical must point there,
    // not at whatever host this API happens to be reached on.
    const siteUrl = (process.env.PUBLIC_APP_URL || 'https://plotraa.com').replace(/\/$/, '');
    const pageUrl = `${siteUrl}/blog/${slug}`;

    return res.status(200).send(
      buildOgHtml({
        title: escapeText(post.meta_title || post.title),
        description,
        imageUrl: post.image_url ? escapeText(post.image_url) : null,
        pageUrl,
        type: 'article',
        extraHead: `<meta name="description" content="${description}" />\n  <link rel="canonical" href="${pageUrl}" />`,
      })
    );
  } catch (error) {
    console.error('Blog OG preview fetch failed:', error);
    return next();
  }
}

module.exports = { servePropertyPreview, serveBlogPreview };
