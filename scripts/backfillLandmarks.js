// scripts/backfillLandmarks.js
//
// One-off backfill: re-queues landmark extraction (nearby schools,
// hospitals, markets, transit) for existing listings, using the SAME
// 'landmark-extraction' queue landmarkWorker.js already consumes — this
// script only enqueues jobs, it never talks to Google Places itself.
//
// Why this exists: landmarkWorker.js had two real bugs (wrong category
// labels, "nearest 3" not actually nearest — see the fix commit) that
// only affects NEW landmark lookups going forward. Every listing whose
// landmarks were already computed before that fix landed is still
// sitting on the old, wrong data until something re-triggers extraction
// for it (a location correction normally would, but that's not going to
// happen for every already-live listing on its own) — this script is
// that one-time re-trigger.
//
// Usage:
//   node scripts/backfillLandmarks.js [--dry-run] [--all-statuses] [--tenant <id>] [--limit <n>]
//
// --dry-run       Print what would be enqueued, enqueue nothing.
// --all-statuses  Include every listing with lat/lng, not just active ones
//                 (default: active only — a pending/inactive listing's
//                 landmarks aren't buyer-facing yet, so they're lower
//                 priority and can pick up the fix the normal way, via
//                 geo-enrichment, once approved).
// --tenant <id>   Scope to one tenant only (e.g. to backfill/verify
//                 against a single test tenant before running platform-wide).
// --limit <n>     Cap how many listings this run enqueues — useful for a
//                 small first pass to confirm the fix looks right on the
//                 live site before backfilling everything.
//
// Actual Google Places calls happen later, at whatever pace
// landmarkWorker.js's own concurrency processes the queue — this script
// doesn't wait for them and doesn't call Google itself, so it's safe to
// run against however many listings exist without worrying about this
// script itself causing an API rate spike.
const knexConfig = require('../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { Queue } = require('bullmq');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

function parseArgs(argv) {
  const args = { dryRun: false, allStatuses: false, tenant: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--all-statuses') args.allStatuses = true;
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else {
      console.error(`Unrecognized argument: ${a}`);
      console.error('Usage: node scripts/backfillLandmarks.js [--dry-run] [--all-statuses] [--tenant <id>] [--limit <n>]');
      process.exit(1);
    }
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    console.error('--limit must be a positive integer.');
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let query = knex('listings')
    .select('id', 'title', 'tenant_id', 'status')
    .whereNotNull('lat')
    .whereNotNull('lng');

  if (!args.allStatuses) query = query.where({ status: 'active' });
  if (args.tenant) query = query.where({ tenant_id: args.tenant });
  query = query.orderBy('created_at', 'asc');
  if (args.limit) query = query.limit(args.limit);

  const listings = await query;

  if (listings.length === 0) {
    console.log('No matching listings found — nothing to backfill.');
    await knex.destroy();
    process.exit(0);
  }

  console.log(`Found ${listings.length} listing(s) to re-queue for landmark extraction` + (args.dryRun ? ' (dry run — nothing will be enqueued):' : ':'));

  if (args.dryRun) {
    for (const l of listings) {
      console.log(`  - ${l.id}  ${l.title || '(untitled)'}  [${l.status}]`);
    }
    await knex.destroy();
    return;
  }

  const landmarkQueue = new Queue('landmark-extraction', {
    connection: { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null },
  });

  let enqueued = 0;
  let failed = 0;
  for (const l of listings) {
    try {
      const listing = await knex('listings').select('lat', 'lng').where({ id: l.id }).first();
      await landmarkQueue.add('extract-infra-landmarks', { listingId: l.id, lat: listing.lat, lng: listing.lng }, {
        attempts: 2,
        backoff: 1000,
      });
      enqueued++;
    } catch (err) {
      failed++;
      console.error(`  Failed to enqueue ${l.id} (${l.title || 'untitled'}): ${err.message}`);
    }
  }

  console.log(`Enqueued ${enqueued} landmark-extraction job(s).` + (failed ? ` ${failed} failed to enqueue — see errors above.` : ''));
  console.log("Jobs will process at whatever pace landmarkWorker.js's own queue concurrency runs at — this script doesn't wait for them to finish.");

  await landmarkQueue.close();
  await knex.destroy();
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
