/**
 * Sale / Rent / Lease listings (4 Nov 2026).
 *
 * Until now every listing was implicitly "for sale". Dealers also list
 * flats/houses/floors/rooms for rent and shops/offices/godowns on lease, and
 * buyers (and AI-call enquiries) already ask for rentals, so:
 *
 * listings
 *   - listing_type: 'sale' | 'rent' | 'lease', NOT NULL DEFAULT 'sale' —
 *     every existing row stays a sale listing, nothing else changes for it.
 *   - monthly_rent / security_deposit / maintenance_charges: rupees.
 *     `price` keeps meaning the sale price only.
 *   - furnishing, preferred_tenant, available_from: rental details.
 *   - lease_term, lock_in, rent_escalation_percent: lease details.
 *   - property_subtype: what the property actually is inside the broad
 *     property_type bucket (Shop / Office / Independent Floor / PG ...).
 *     property_type itself is unchanged so existing filters keep working.
 *
 * agent_listing_drafts
 *   - listing_type: the dealer's answer to the first question ("Sell, Rent
 *     or Lease?"), kept on the draft so a bare "2" never has to go through
 *     the model.
 *   - details_requested_at: the one optional rental/lease details question
 *     was asked (asked once only, like location_pin_requested_at).
 *
 * seller_leads
 *   - listing_type: an owner on the public "sell / rent out your property"
 *     form can now say they want to RENT OUT or LEASE OUT, not only sell.
 *
 * Additive only; `down` reverses it.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('listings', (table) => {
    table.string('listing_type', 10).notNullable().defaultTo('sale');
    table.decimal('monthly_rent', 14, 2).nullable();
    table.decimal('security_deposit', 14, 2).nullable();
    table.decimal('maintenance_charges', 12, 2).nullable();
    table.string('furnishing', 20).nullable();
    table.string('preferred_tenant', 20).nullable();
    table.string('available_from', 60).nullable();
    table.string('lease_term', 60).nullable();
    table.string('lock_in', 60).nullable();
    table.decimal('rent_escalation_percent', 5, 2).nullable();
    table.string('property_subtype', 40).nullable();
  });
  await knex.raw(`
    ALTER TABLE listings
    ADD CONSTRAINT listings_listing_type_check
    CHECK (listing_type IN ('sale', 'rent', 'lease'))
  `);
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_listings_type_status ON listings (listing_type, status)');

  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.string('listing_type', 10).nullable();
    table.timestamp('details_requested_at').nullable();
  });

  await knex.schema.alterTable('seller_leads', (table) => {
    table.string('listing_type', 10).notNullable().defaultTo('sale');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('seller_leads', (table) => {
    table.dropColumn('listing_type');
  });
  await knex.schema.alterTable('agent_listing_drafts', (table) => {
    table.dropColumn('details_requested_at');
    table.dropColumn('listing_type');
  });
  await knex.raw('DROP INDEX IF EXISTS idx_listings_type_status');
  await knex.raw('ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_listing_type_check');
  await knex.schema.alterTable('listings', (table) => {
    table.dropColumn('property_subtype');
    table.dropColumn('rent_escalation_percent');
    table.dropColumn('lock_in');
    table.dropColumn('lease_term');
    table.dropColumn('available_from');
    table.dropColumn('preferred_tenant');
    table.dropColumn('furnishing');
    table.dropColumn('maintenance_charges');
    table.dropColumn('security_deposit');
    table.dropColumn('monthly_rent');
    table.dropColumn('listing_type');
  });
};
