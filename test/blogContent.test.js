const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeBlogHtml, htmlToText, slugify, isValidSlug, normalizeTags } = require('../src/utils/blogContent');

test('sanitizeBlogHtml keeps the allowed formatting tags', () => {
  const html = '<h2>Heading</h2><p>Some <strong>bold</strong> and <em>italic</em>.</p><ul><li>One</li></ul>';
  assert.equal(sanitizeBlogHtml(html), html);
});

test('sanitizeBlogHtml drops scripts, styles and their content', () => {
  assert.equal(sanitizeBlogHtml('<p>Hi</p><script>alert(1)</script><style>p{}</style>'), '<p>Hi</p>');
});

test('sanitizeBlogHtml strips attributes, including event handlers', () => {
  assert.equal(
    sanitizeBlogHtml('<p style="color:red" onclick="x()" class="a">Text</p><img src=x onerror=alert(1)>'),
    '<p>Text</p>'
  );
});

test('sanitizeBlogHtml only keeps safe hrefs', () => {
  assert.equal(
    sanitizeBlogHtml('<a href="https://plotraa.com/pricing" onclick="x()">Pricing</a>'),
    '<a href="https://plotraa.com/pricing" target="_blank" rel="noopener noreferrer">Pricing</a>'
  );
  assert.equal(sanitizeBlogHtml('<a href="/pricing">Pricing</a>'), '<a href="/pricing">Pricing</a>');
  assert.equal(sanitizeBlogHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeBlogHtml('<a href="//evil.example">x</a>'), '<a>x</a>');
});

test('sanitizeBlogHtml cannot be tricked by nested tag fragments', () => {
  const out = sanitizeBlogHtml('<scr<script>x</script>ipt>alert(1)</scr<b>ipt>');
  assert.ok(!/<script/i.test(out), out);
});

test('sanitizeBlogHtml is idempotent and normalises div/h1', () => {
  const once = sanitizeBlogHtml('<div>Line</div><h1>Big</h1><a href="https://a.b/?x=1&y=2">l</a>');
  assert.equal(once, '<p>Line</p><h2>Big</h2><a href="https://a.b/?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">l</a>');
  assert.equal(sanitizeBlogHtml(once), once);
});

test('htmlToText', () => {
  assert.equal(htmlToText('<p>Hello&nbsp;<strong>world</strong></p><p><br></p>'), 'Hello world');
  assert.equal(htmlToText('<p><br></p>'), '');
});

test('slugify + isValidSlug', () => {
  assert.equal(slugify('10 Tips: Buying a Plot in Ludhiana!'), '10-tips-buying-a-plot-in-ludhiana');
  assert.equal(slugify('  Rent & Buy — what’s better?  '), 'rent-and-buy-whats-better');
  assert.equal(slugify('ਪੰਜਾਬੀ'), '');
  assert.ok(isValidSlug('a-b-1'));
  assert.ok(!isValidSlug('A-b'));
  assert.ok(!isValidSlug('a--b'));
  assert.ok(!isValidSlug('-a'));
  assert.ok(!isValidSlug(''));
});

test('normalizeTags', () => {
  assert.deepEqual(normalizeTags('Real Estate, ludhiana ,, real estate'), ['Real Estate', 'ludhiana']);
  assert.deepEqual(normalizeTags(['a', ' b ', 'A']), ['a', 'b']);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('sanitizeBlogHtml drops empty paragraphs', () => {
  assert.equal(sanitizeBlogHtml('<p>A</p><p></p><p><br></p><p>&nbsp; </p><p>B</p>'), '<p>A</p><p>B</p>');
});
