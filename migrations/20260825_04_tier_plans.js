/**
 * Creates the three new plan rows the implementation brief specifies
 * (Tier 1 WhatsApp Only / Tier 2 Dashboard / Tier 3 Calling), using the
 * gate columns added in 20260825_01/03.
 *
 * Purely additive — does NOT touch or rename the existing starter/growth/
 * unlimited plans, and does NOT move any existing tenant onto a new plan
 * key. What happens to tenants currently on starter/growth/unlimited is a
 * business decision (deferred explicitly when the gate columns were
 * added) — this migration only makes the new tiers exist as real,
 * selectable plans so new signups (in particular the WhatsApp self-serve
 * onboarding flow, which needs a real tier1 plan row to check out
 * against) have something to reference.
 *
 * monthly_listing_limit for tier1: the brief specifies "40-50/month" — a
 * range, not a single number. Seeded at 50 (the top of that range);
 * adjust via PATCH /api/v1/admin/plans/tier1 if 40 (or anything else) was
 * actually intended — no deploy needed either way.
 *
 * tier3.overage_rate_paise_per_minute is deliberately left NULL — the
 * brief specifies the 100 included minutes but never states a per-minute
 * overage rate, and that's a real price to set, not something to invent
 * here. callingUsageService.js already treats a null rate as "usage
 * tracked, no overage computed" — set it via the same PATCH endpoint
 * once a rate is decided.
 */

exports.up = async function (knex) {
  await knex('plans').insert([
    {
      key: 'tier1',
      label: 'WhatsApp Only',
      price_inr: 1999,
      listing_limit: null, // superseded by monthly_listing_limit
      monthly_listing_limit: 50,
      features: JSON.stringify(['WhatsApp-only listing intake', 'No dashboard login', '1 WhatsApp number', 'Up to 50 listings/month']),
      sort_order: 1,
      dashboard_access: false,
      calling_access: false,
      max_whatsapp_numbers: 1,
    },
    {
      key: 'tier2',
      label: 'Dashboard',
      price_inr: 4999,
      listing_limit: null,
      monthly_listing_limit: 100,
      features: JSON.stringify(['Full dashboard access', 'Dashboard + WhatsApp + web chat listing intake', 'Up to 3 WhatsApp numbers', 'Up to 100 listings/month']),
      sort_order: 2,
      dashboard_access: true,
      calling_access: false,
      max_whatsapp_numbers: 3,
    },
    {
      key: 'tier3',
      label: 'Calling',
      price_inr: 14999,
      listing_limit: null,
      monthly_listing_limit: 200,
      features: JSON.stringify(['Everything in Dashboard', 'Inbound/outbound AI calling', '100 calling minutes/month included', 'Up to 5 WhatsApp numbers', 'Up to 200 listings/month']),
      sort_order: 3,
      dashboard_access: true,
      calling_access: true,
      max_whatsapp_numbers: 5,
      included_calling_minutes: 100,
      overage_rate_paise_per_minute: null,
    },
  ]);
};

exports.down = async function (knex) {
  await knex('plans').whereIn('key', ['tier1', 'tier2', 'tier3']).delete();
};
