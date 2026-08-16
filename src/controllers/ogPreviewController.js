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

function buildOgHtml({ title, description, imageUrl, pageUrl }) {
  const safeTitle = title.replace(/"/g, '&quot;');
  const safeDesc = description.replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${safeTitle}</title>
  <meta property="og:type" content="website" />
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

    const address = listing.formatted_address || listing.raw_address;
    const priceFormatted = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(listing.price);

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

module.exports = { servePropertyPreview };
