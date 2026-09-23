// src/services/callingUsageService.js
//
// Calling-minute usage/overage for the new Tier 3 "100 min/month included,
// then billed per-minute" plan concept — a distinct thing from
// dealerOpsController.js's MONTHLY_CALL_CAP, which is a flat, uncapped-by-
// plan safety guard against runaway usage (that stays as-is; see its own
// comment).
//
// Deliberately does NOT auto-charge anything — Stripe metered billing
// integration is a separate, larger piece that needs its own explicit
// product sign-off on exactly how/when a card gets charged for overage.
// This computes and surfaces what's owed; charging it is a follow-up.
//
// Usage is computed live (SUM over ai_voice_calls), not maintained as a
// separate incrementally-updated rollup table — at this call volume (the
// existing safety cap is 500 calls/tenant/month) a live aggregate query
// is cheap and always exactly correct, with no rollup-drift risk and no
// need to touch wayneRingSyncService.js's two call-finalization code
// paths at all.

function currentMonthStart() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns { minutesUsed, includedMinutes, overageMinutes, overageRatePaisePerMinute, overageOwedPaise }.
 * includedMinutes/overageRatePaisePerMinute are null (and overageMinutes/
 * overageOwedPaise are 0) for any plan that hasn't opted into this concept
 * — i.e. every plan today except a future Tier 3 row.
 */
async function getMonthlyCallingUsage(knex, tenantId) {
  const tenant = await knex('tenants').where({ id: tenantId }).first();
  const plan = await knex('plans').where({ key: tenant?.plan }).first();

  const { total } = await knex('ai_voice_calls')
    .where({ tenant_id: tenantId })
    .andWhere('called_at', '>=', currentMonthStart())
    .sum('duration_seconds as total')
    .first();

  const minutesUsed = Math.ceil((parseInt(total, 10) || 0) / 60);
  const includedMinutes = plan?.included_calling_minutes ?? null;
  const overageRatePaisePerMinute = plan?.overage_rate_paise_per_minute ?? null;

  const overageMinutes = includedMinutes != null ? Math.max(0, minutesUsed - includedMinutes) : 0;
  const overageOwedPaise = (overageMinutes > 0 && overageRatePaisePerMinute != null)
    ? overageMinutes * overageRatePaisePerMinute
    : 0;

  return { minutesUsed, includedMinutes, overageMinutes, overageRatePaisePerMinute, overageOwedPaise };
}

module.exports = { getMonthlyCallingUsage };
