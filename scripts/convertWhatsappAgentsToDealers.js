#!/usr/bin/env node
// scripts/convertWhatsappAgentsToDealers.js
//
// One-time move for people who joined on WhatsApp BEFORE the dealer model
// (21 Oct 2026): they were approved as role 'agent' inside a shared tenant
// (Wayne E Solutions). This gives each of them their own dealer account:
// a new tenant, their user moved into it as role 'owner', and their own
// listings, drafts, payments and those listings' leads moved with them.
//
// Only users created by the OLD WhatsApp approval (placeholder email
// agent.<digits>@wa-signup.plotra.internal) are touched; sub-dealers a
// dealer added (subdealer.* or a real email) are never moved. Each converted
// dealer gets a fresh 7-day free trial (unless they already paid), the same as
// a new dealer. Already-converted dealers without a trial:
// scripts/repairConvertedDealers.js.
//
// DRY RUN by default: prints what would move and changes nothing.
//   node scripts/convertWhatsappAgentsToDealers.js            # dry run, all
//   node scripts/convertWhatsappAgentsToDealers.js --apply    # do it
//   node scripts/convertWhatsappAgentsToDealers.js --phone +919876543210 --apply
//
// Each person is moved in their own transaction; a failure rolls back only
// that person and the script carries on. Take a DB backup first.

require('dotenv').config();
const knexConfig = require('../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { chooseDealerCities, TRIAL_PLAN, grantMissingTrial } = require('../src/services/dealerOnboardingService');
const { setTenantCities } = require('../src/services/tenantCityService');
const { normalizePhone } = require('../src/utils/phone');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const phoneArg = args.includes('--phone') ? normalizePhone(args[args.indexOf('--phone') + 1]) : null;

async function planFor(trx, user) {
  const listings = await trx('listings')
    .where({ tenant_id: user.tenant_id })
    .andWhere((b) => b.where('created_by', user.id).orWhere('assigned_agent_id', user.id))
    .select('id');
  const listingIds = listings.map((l) => l.id);
  // Leads that only ever touched this person's listings.
  let leadIds = [];
  if (listingIds.length) {
    const rows = await trx('listing_visits').whereIn('listing_id', listingIds).whereNotNull('lead_id').distinct('lead_id');
    const candidate = rows.map((r) => r.lead_id);
    if (candidate.length) {
      const shared = await trx('listing_visits').whereIn('lead_id', candidate).whereNotIn('listing_id', listingIds).distinct('lead_id');
      const sharedSet = new Set(shared.map((r) => r.lead_id));
      leadIds = candidate.filter((id) => !sharedSet.has(id));
    }
  }
  const myCities = await trx('user_cities').where({ user_id: user.id }).pluck('city_id');
  const tenantPrimary = await trx('tenant_cities').where({ tenant_id: user.tenant_id, is_primary: true }).first('city_id');
  const cityIds = myCities.length ? myCities : (tenantPrimary ? [tenantPrimary.city_id] : []);
  return { listingIds, leadIds, cityIds };
}

async function convert(user) {
  return knex.transaction(async (trx) => {
    const plan = await planFor(trx, user);
    const summary = { name: user.name, phone: user.phone, listings: plan.listingIds.length, leads: plan.leadIds.length };
    if (!APPLY) return summary;

    const oldTenant = await trx('tenants').where({ id: user.tenant_id }).first('plan');
    const [tenant] = await trx('tenants').insert({
      business_name: String(user.name || 'Dealer').slice(0, 255),
      plan: TRIAL_PLAN || oldTenant?.plan,
      whatsapp_mode: 'shared',
      status: 'active',
    }).returning(['id']);
    const choice = await chooseDealerCities(trx, { cityIds: plan.cityIds, areaText: '' });
    await setTenantCities(trx, tenant.id, choice);
    await trx('tenant_configs').insert({ tenant_id: tenant.id, bsp_provider_type: 'shared_gateway', bsp_auth_token: null });

    await trx('user_cities').where({ user_id: user.id }).del();
    await trx('users').where({ id: user.id }).update({ tenant_id: tenant.id, role: 'owner', updated_at: trx.fn.now() });
    // 22 Oct: a converted dealer now gets the 7-day trial (and a clean cycle)
    // like every new dealer, instead of being left with the old monthly cycle
    // that blocked them (DEALER_UNPAID when a lead was assigned).
    await grantMissingTrial(trx, { ...user, role: 'owner', tenant_id: tenant.id });
    if (plan.listingIds.length) await trx('listings').whereIn('id', plan.listingIds).update({ tenant_id: tenant.id });
    if (plan.leadIds.length) await trx('leads').whereIn('id', plan.leadIds).update({ tenant_id: tenant.id });
    await trx('agent_listing_drafts').where({ user_id: user.id }).update({ tenant_id: tenant.id });
    await trx('payment_submissions').where({ agent_id: user.id }).update({ tenant_id: tenant.id });
    await trx('assistant_messages').where({ user_id: user.id }).update({ tenant_id: tenant.id });
    await trx('support_requests').where({ user_id: user.id }).update({ tenant_id: tenant.id });
    return { ...summary, newTenantId: tenant.id };
  });
}

(async () => {
  let q = knex('users').where({ role: 'agent' }).where('email', 'like', 'agent.%@wa-signup.plotra.internal');
  if (phoneArg) q = q.where({ phone: phoneArg });
  const users = await q.select('id', 'name', 'phone', 'tenant_id');
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'}: ${users.length} WhatsApp agent(s) to turn into dealers`);
  let ok = 0; let failed = 0;
  for (const user of users) {
    try {
      const r = await convert(user);
      console.log(`${APPLY ? 'moved' : 'would move'}: ${r.name} (${r.phone}) — ${r.listings} listing(s), ${r.leads} lead(s)${r.newTenantId ? ` -> tenant ${r.newTenantId}` : ''}`);
      ok++;
    } catch (err) {
      console.error(`FAILED for ${user.name} (${user.phone}): ${err.message} — nothing changed for this person`);
      failed++;
    }
  }
  console.log(`Done: ${ok} ok, ${failed} failed.${APPLY ? '' : ' Run again with --apply to make the changes.'}`);
  await knex.destroy();
  process.exit(failed ? 1 : 0);
})();
