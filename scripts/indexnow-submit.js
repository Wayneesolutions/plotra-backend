#!/usr/bin/env node
/**
 * Submit URLs to IndexNow after a frontend deploy that changed static pages.
 *
 *   node scripts/indexnow-submit.js                 # every page in the sitemap
 *   node scripts/indexnow-submit.js /pricing /faq   # just these paths
 *
 * Needs INDEXNOW_KEY (and PUBLIC_SITE_URL if not https://plotraa.com) in .env.
 */
require('dotenv').config();
const axios = require('axios');
const { submitUrls, indexNowKey } = require('../src/services/indexNowService');
const { SITE_URL } = require('../src/services/seoPages');

(async () => {
  if (!indexNowKey()) {
    console.error('INDEXNOW_KEY is not set (8-128 letters, digits or hyphens).');
    process.exit(1);
  }
  let paths = process.argv.slice(2);
  if (!paths.length) {
    const { data } = await axios.get(`${SITE_URL}/sitemap.xml`, { responseType: 'text' });
    paths = [...String(data).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  }
  const result = await submitUrls(paths);
  console.log(`Submitted ${paths.length} URL(s):`, result);
  process.exit(result.error ? 1 : 0);
})();
