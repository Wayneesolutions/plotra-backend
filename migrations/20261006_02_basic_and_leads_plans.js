/**
 * Oct 2026 package structure — six plans in two categories, replacing
 * WhatsApp Only / Dashboard / Calling (tier1/tier2/tier3) as what the
 * pricing page and the admin Plans tab offer:
 *
 *   Basic              Basic ₹5,000 · Multi User Basic ₹10,000 (4 users)
 *                      · AI Calling ₹14,999            — all 40% off
 *   Basic with Leads   Basic with Leads ₹7,999 (30 leads) · Multi User
 *                      with Leads ₹14,999 (50 leads) · AI Calling with
 *                      Leads ₹22,999 (50 leads)        — all 30% off
 *
 * Every other plan is DEACTIVATED, not deleted: tenants.plan is a plain
 * string with no FK, and the plan gates (dashboard_access, calling_access,
 * listing limits, multi_agent_whatsapp) are read from the tenant's own
 * plan row regardless of is_active — so tenants still on an old plan keep
 * working untouched, the old plans just stop being offered. An old plan
 * with no tenants on it can then be removed with the admin Delete button.
 *
 * Gate values (listing limits, WhatsApp numbers, calling minutes) are the
 * ones the listing/WhatsApp/calling code actually enforces. Listings per
 * month and the feature bullets are editable from the admin Plans tab; the
 * rest via PATCH /api/v1/admin/plans/:key.
 */

// Features, listing limits, WhatsApp-number caps and calling minutes are
// carried over from the plans these replace. Basic is WhatsApp-only — NO
// dashboard (like the old WhatsApp Only tier). The dashboard, and the
// dashboard-only features (web chat intake, lead inbox), start at the
// multi-user plans. The AI Calling plans take the old Calling tier's
// (tier3, ₹14,999) limits exactly and keep its dashboard access.
const BASIC_FEATURES = [
  'WhatsApp listing intake',
  'AI property extraction',
  'Public listing pages',
  '1 user',
  '1 WhatsApp number',
  'Up to 100 listings/month',
];
const MULTI_USER_FEATURES = [
  'Everything in Basic',
  'Full dashboard access',
  'Dashboard + WhatsApp + web chat listing intake',
  'Lead inbox',
  '4 users included',
  'Up to 4 WhatsApp numbers',
  'Per-agent WhatsApp listing attribution',
  'Up to 200 listings/month',
];
const AI_CALLING_FEATURES = [
  'Everything in Basic',
  'Full dashboard access',
  'Inbound/outbound AI calling',
  '100 calling minutes/month included',
  'Up to 5 WhatsApp numbers',
  'Up to 200 listings/month',
];

const BASIC_GATES = {
  dashboard_access: false, calling_access: false, multi_agent_whatsapp: false,
  max_whatsapp_numbers: 1, monthly_listing_limit: 100, included_calling_minutes: null,
};
const MULTI_USER_GATES = {
  dashboard_access: true, calling_access: false, multi_agent_whatsapp: true,
  max_whatsapp_numbers: 4, monthly_listing_limit: 200, included_calling_minutes: null,
};
const AI_CALLING_GATES = {
  dashboard_access: true, calling_access: true, multi_agent_whatsapp: false,
  max_whatsapp_numbers: 5, monthly_listing_limit: 200, included_calling_minutes: 100,
};

const NEW_PLANS = [
  {
    key: 'basic', label: 'Basic', category: 'basic', price_inr: 5000, discount_percent: 40,
    max_users: 1, included_leads: null, sort_order: 1, ...BASIC_GATES,
    features: BASIC_FEATURES,
  },
  {
    key: 'multi_user_basic', label: 'Multi User Basic', category: 'basic', price_inr: 10000, discount_percent: 40,
    max_users: 4, included_leads: null, sort_order: 2, ...MULTI_USER_GATES,
    features: MULTI_USER_FEATURES,
  },
  {
    key: 'ai_calling', label: 'AI Calling', category: 'basic', price_inr: 14999, discount_percent: 40,
    max_users: null, included_leads: null, sort_order: 3, ...AI_CALLING_GATES,
    features: AI_CALLING_FEATURES,
  },
  {
    key: 'basic_leads', label: 'Basic with Leads', category: 'basic_with_leads', price_inr: 7999, discount_percent: 30,
    max_users: 1, included_leads: 30, sort_order: 4, ...BASIC_GATES,
    features: [...BASIC_FEATURES, '30 leads included'],
  },
  {
    key: 'multi_user_leads', label: 'Multi User with Leads', category: 'basic_with_leads', price_inr: 14999, discount_percent: 30,
    max_users: 4, included_leads: 50, sort_order: 5, ...MULTI_USER_GATES,
    features: [...MULTI_USER_FEATURES, '50 leads included'],
  },
  {
    key: 'ai_calling_leads', label: 'AI Calling with Leads', category: 'basic_with_leads', price_inr: 22999, discount_percent: 30,
    max_users: null, included_leads: 50, sort_order: 6, ...AI_CALLING_GATES,
    features: [...AI_CALLING_FEATURES, '50 leads included'],
  },
];

const NEW_KEYS = NEW_PLANS.map((p) => p.key);
// The plans that were active before this migration (starter/growth/
// unlimited were already switched off in 20260825_06).
const PREVIOUSLY_ACTIVE = ['tier1', 'tier2', 'tier3'];

exports.up = async function (knex) {
  const existing = await knex('plans').whereIn('key', NEW_KEYS).select('key');
  const existingKeys = new Set(existing.map((r) => r.key));

  const rows = NEW_PLANS
    .filter((p) => !existingKeys.has(p.key))
    .map((p) => ({
      ...p,
      features: JSON.stringify(p.features),
      listing_limit: null, // legacy lifetime cap — superseded by monthly_listing_limit
      is_active: true,
    }));

  if (rows.length) await knex('plans').insert(rows);

  await knex('plans').whereNotIn('key', NEW_KEYS).update({ is_active: false });
};

exports.down = async function (knex) {
  await knex('plans').whereIn('key', PREVIOUSLY_ACTIVE).update({ is_active: true });
  // Only removes the new rows if no tenant was moved onto them meanwhile.
  const inUse = await knex('tenants').whereIn('plan', NEW_KEYS).distinct('plan');
  const inUseKeys = inUse.map((r) => r.plan);
  await knex('plans').whereIn('key', NEW_KEYS).whereNotIn('key', inUseKeys).delete();
  if (inUseKeys.length) await knex('plans').whereIn('key', inUseKeys).update({ is_active: false });
};
