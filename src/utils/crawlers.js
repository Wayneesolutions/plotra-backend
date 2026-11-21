/**
 * User-agents that should receive server-rendered HTML / OG tags instead of
 * the client-only SPA. Includes the AI search and answer bots, which don't
 * run JavaScript at all.
 */
const KNOWN_CRAWLERS = [
  // social / messaging link previews
  'facebookexternalhit',
  'WhatsApp',
  'Twitterbot',
  'Slackbot',
  'LinkedInBot',
  'TelegramBot',
  // search engines
  'Googlebot',
  'bingbot',
  'Bingbot',
  'DuckDuckBot',
  'Applebot',
  'YandexBot',
  // AI search / assistants
  'OAI-SearchBot',
  'ChatGPT-User',
  'GPTBot',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
];

function isCrawler(userAgent = '') {
  const ua = String(userAgent || '');
  return KNOWN_CRAWLERS.some((bot) => ua.includes(bot));
}

module.exports = { KNOWN_CRAWLERS, isCrawler };
