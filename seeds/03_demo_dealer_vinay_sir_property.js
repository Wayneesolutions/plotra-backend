const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/**
 * Investor-demo seed: adds one demo dealer tenant ("Vinay Sir Property")
 * populated with real listings pulled from the "Property details" WhatsApp
 * group, so there's a populated, realistic-looking account ready the moment
 * this deploys — no need to manually type in demo data before a pitch.
 *
 * IMPORTANT — unlike seeds/01_phase0_seed.js, this file does NOT delete
 * anything first. 01_phase0_seed.js wipes every tenant/listing/user table
 * before inserting — safe for a first-ever local setup, but running
 * `npm run seed` again on a database that already has real tenants/listings
 * in it will destroy that data. This seed is additive and idempotent: it
 * checks whether the demo tenant already exists and skips cleanly if so,
 * so it's safe to re-run.
 */
exports.seed = async function (knex) {
  const existing = await knex('tenants').where({ business_name: 'Vinay Sir Property' }).first();
  if (existing) {
    console.log('Demo dealer "Vinay Sir Property" already exists — skipping (seed is idempotent).');
    return;
  }

  const tenantId = knex.raw('uuid_generate_v4()');

  const [tenant] = await knex('tenants')
    .insert({
      business_name: 'Vinay Sir Property',
      plan: 'unlimited', // demo account — show every feature to the investor, no plan-limit friction
      whatsapp_mode: 'shared',
      status: 'active',
    })
    .returning(['id', 'business_name']);

  const plaintextPassword = 'VinaySir@2026';
  const hashedPassword = await bcrypt.hash(plaintextPassword, 10);

  const [owner] = await knex('users')
    .insert({
      tenant_id: tenant.id,
      name: 'Vinay Sir',
      email: 'vinay@vinaysirproperty.demo',
      password_hash: hashedPassword,
      role: 'owner',
    })
    .returning(['id', 'email']);

  await knex('tenant_configs').insert({
    tenant_id: tenant.id,
    bsp_provider_type: 'shared_gateway',
    bsp_auth_token: null,
  });

  // Real listings this dealer actually shared in the WhatsApp group, minus
  // the one that's already sold (Sangowal petrol pump property).
  const listings = [
    {
      title: '298 Gaj Plot — Golf Link',
      raw_address: 'Plot No. 24, Golf Link, near Marwari Flats, Ludhiana, Punjab',
      price: 20860000, // 298 gaj — no demand rate was quoted in chat; priced at an estimated ~₹70,000/gaj Golf Link benchmark. Confirm with Vinay before showing a firm number to a buyer.
      plot_area: '298 Gaj',
      property_type: 'Plot',
      description: 'Plot in Golf Link, near Marwari Flats. Listed by Vinay Sir Property.',
    },
    {
      title: '470 Gaj Plot — Udham Singh Nagar',
      raw_address: '43 B/1, Udham Singh Nagar, Ludhiana, Punjab',
      price: 32900000, // same caveat — no demand price given in the original chat
      plot_area: '470 Gaj',
      property_type: 'Plot',
      description: 'Plot in Udham Singh Nagar (43 B/1). Listed by Vinay Sir Property.',
    },
    {
      title: '500 Gaj Corner Kothi — Kichlu Nagar C Block',
      raw_address: 'Kichlu Nagar C Block, Ludhiana, Punjab',
      price: 45000000,
      plot_area: '500 Gaj',
      property_type: 'Villa',
      description: 'Corner kothi on a 60 ft wide road, Kichlu Nagar C Block. Listed by Vinay Sir Property.',
    },
    {
      title: '6,000 Gaj Plot — Main Dhillon Road',
      raw_address: 'Main Dhillon Road, Ludhiana, Punjab',
      price: 55000000, // ₹5.5 Cr as quoted in chat
      plot_area: '6000 Gaj',
      property_type: 'Plot',
      description: 'Large plot on Main Dhillon Road. Listed by Vinay Sir Property.',
    },
    {
      title: '7,000 Sq Yd Commercial Plot — GT Road, Doraha',
      raw_address: 'Main GT Road, Doraha, opposite Manji Sahib Gurdwara, Ludhiana, Punjab',
      price: 70000000, // ₹10,000/gaj x 7000 sq yd as quoted in chat
      plot_area: '7000 Sq Yd',
      property_type: 'Commercial',
      description: '105 ft frontage on Main GT Road, Doraha, opposite Manji Sahib Gurdwara. Listed by Vinay Sir Property.',
    },
  ];

  // NOTE on prices: only two of these five listings had an actual demand
  // price quoted in the WhatsApp chat (Dhillon Road ₹5.5 Cr, GT Road Doraha
  // ₹10,000/gaj). The other three never had a price mentioned — I estimated
  // a plausible per-gaj rate for their localities so the demo doesn't show
  // ₹0, but these are NOT real quoted prices. Get actual numbers from Vinay
  // before using this for anything beyond an investor demo.

  const geoEnrichmentQueue = (() => {
    try {
      const { Queue } = require('bullmq');
      return new Queue('geo-enrichment', {
        connection: {
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: 6379,
          // BUG FIX: ioredis retries connecting indefinitely by default,
          // which made this whole seed script hang forever if Redis wasn't
          // reachable yet (a real risk during a fresh deploy's first setup
          // run) instead of the try/catch below ever getting a chance to
          // catch anything. Capping retries makes a genuinely-unreachable
          // Redis fail within a couple seconds instead of hanging the
          // deploy step indefinitely.
          maxRetriesPerRequest: 1,
          retryStrategy: () => null, // don't keep retrying — fail fast
          connectTimeout: 3000,
          lazyConnect: true,
        },
      });
    } catch (err) {
      return null;
    }
  })();

  for (const listing of listings) {
    const publicSlug = crypto.randomBytes(16).toString('hex');
    const [inserted] = await knex('listings')
      .insert({
        tenant_id: tenant.id,
        created_by: owner.id,
        title: listing.title,
        raw_address: listing.raw_address,
        price: listing.price,
        plot_area: listing.plot_area,
        property_type: listing.property_type,
        description: listing.description,
        public_slug: publicSlug,
        status: 'pending', // same as a normal dealer-created listing — waits on the geo-enrichment worker
      })
      .returning(['id', 'title']);

    // Enqueue exactly the same job the real dashboard "Add Property" flow
    // does, so once this deploys with a real GOOGLE_MAPS_API_KEY and the
    // geoEnrichmentWorker running, these listings get real satellite/street
    // view imagery automatically — no separate demo-only code path.
    if (geoEnrichmentQueue) {
      try {
        await geoEnrichmentQueue.add('enrich-property-coords', {
          listingId: inserted.id,
          rawAddress: listing.raw_address,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        });
      } catch (err) {
        console.warn(`Could not enqueue geo-enrichment for "${inserted.title}" (Redis not reachable during seed — the worker will need it triggered manually, or re-save the listing from the dashboard):`, err.message);
      }
    }
  }

  console.log('Demo dealer seeded successfully:');
  console.log(`-> Tenant: ${tenant.business_name}`);
  console.log(`-> Login: ${owner.email} / ${plaintextPassword}`);
  console.log(`-> ${listings.length} listings added (status: pending — will populate satellite/street imagery once the geo-enrichment worker picks up the queued jobs).`);
};
