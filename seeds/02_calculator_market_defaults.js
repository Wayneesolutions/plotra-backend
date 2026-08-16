/**
 * Seed data for the rent-vs-buy calculator's config tables.
 * Covers the cities/states Wayne E Solutions actually operates in today.
 * The calculator falls back to a generic default (5% appreciation, 7%
 * stamp duty) for any city/state not listed here, so this can be extended
 * incrementally as new markets are added — no code change needed.
 */
exports.seed = async function (knex) {
  await knex('city_market_defaults')
    .insert([
      { city: 'Ludhiana', appreciation_rate: 6.00, avg_rent_per_sqft: 12.00 },
      { city: 'Chandigarh', appreciation_rate: 7.50, avg_rent_per_sqft: 22.00 },
      { city: 'Mohali', appreciation_rate: 7.00, avg_rent_per_sqft: 18.00 },
      { city: 'Zirakpur', appreciation_rate: 6.50, avg_rent_per_sqft: 15.00 },
      { city: 'Winnipeg', appreciation_rate: 4.00, avg_rent_per_sqft: 28.00 },
    ])
    .onConflict('city')
    .ignore();

  await knex('state_stamp_duty_rates')
    .insert([
      { state: 'Punjab', rate_percent: 7.00, registration_fee_percent: 1.00 },
      { state: 'Chandigarh', rate_percent: 6.00, registration_fee_percent: 1.00 },
      { state: 'Manitoba', rate_percent: 1.50, registration_fee_percent: 0.00 },
    ])
    .onConflict('state')
    .ignore();
};
