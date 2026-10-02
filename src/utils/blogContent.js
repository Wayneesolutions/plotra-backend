/**
 * Helpers for blog post content coming from the blog admin panel.
 *
 * The post body ("description") is written in a small rich-text editor and
 * stored as HTML, then rendered on the public blog page with
 * dangerouslySetInnerHTML — so it is reduced to a fixed allowlist of tags
 * here, on the way in, no matter what the editor (or a pasted Google Doc,
 * or a hand-made request) sent.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u',
  'ul', 'ol', 'li', 'a', 'blockquote',
]);

// Removed together with everything inside them.
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template|svg|math|head|title)\b[\s\S]*?<\/\1\s*>/gi;

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

function escapeAttr(value) {
  return String(value)
    .replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeOnce(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_WITH_CONTENT, '')
    .replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (_match, slash, rawTag, attrs) => {
      let tag = rawTag.toLowerCase();
      if (tag === 'div') tag = 'p'; // contentEditable emits <div> for new lines
      if (tag === 'h1') tag = 'h2'; // the page's only <h1> is the post title
      if (!ALLOWED_TAGS.has(tag)) return '';

      if (slash) return tag === 'br' ? '' : `</${tag}>`;
      if (tag !== 'a') return `<${tag}>`;

      const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
      const href = (hrefMatch ? hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '' : '').trim();
      if (!href || !SAFE_HREF.test(href)) return '<a>';

      const external = /^https?:\/\//i.test(href);
      return external
        ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">`
        : `<a href="${escapeAttr(href)}">`;
    });
}

/** Reduce arbitrary HTML to the blog allowlist. Idempotent. */
function sanitizeBlogHtml(input) {
  let html = String(input ?? '');
  // Removing a disallowed tag can splice a new one together out of what was
  // around it, so repeat until nothing changes.
  for (let i = 0; i < 10; i += 1) {
    const next = sanitizeOnce(html);
    if (next === html) break;
    html = next;
  }
  // Empty paragraphs (contentEditable leaves them behind) only add stray gaps.
  html = html.replace(/<p>(?:\s|&nbsp;|<br>)*<\/p>/gi, '');
  return html.trim();
}

/** Plain text of an HTML fragment — for "is the body empty?" and excerpts. */
function htmlToText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 120;

/** "10 Tips: Buying a Plot in Ludhiana!" -> "10-tips-buying-a-plot-in-ludhiana" */
function slugify(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

function isValidSlug(slug) {
  return typeof slug === 'string' && slug.length <= SLUG_MAX && SLUG_PATTERN.test(slug);
}

const TAG_MAX_COUNT = 15;
const TAG_MAX_LENGTH = 40;

/**
 * Accepts an array or a comma-separated string. Trims, drops empties,
 * de-duplicates case-insensitively (first spelling wins).
 */
function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, TAG_MAX_COUNT);
}

module.exports = {
  sanitizeBlogHtml,
  htmlToText,
  slugify,
  isValidSlug,
  normalizeTags,
  SLUG_MAX,
};
