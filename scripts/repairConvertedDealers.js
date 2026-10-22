#!/usr/bin/env node
// scripts/repairConvertedDealers.js
//
// Fixes dealers that scripts/convertWhatsappAgentsToDealers.js already moved
// BEFORE it set a trial (22 Oct bug): they have no trial, no plan, and an old
// monthly cycle that blocked them, so assigning a lead to them fails with
// DEALER_UNPAID.
//
// For each dealer (role 'owner') that has no trial_ends_at and never had an
// approved payment: start a 7-day free trial now, switch new listings back
// on, restart their cycle, clear the stale old package, and make sure their
// account runs on a plan that exists. Dealers who really paid are left alone.
//
// DRY RUN by default:
//   node scripts/repairConvertedDealers.js                       # list what would change
//   node scripts/repairConvertedDealers.js --apply               # do it
//   node scripts/repairConvertedDealers.js --phone +919876543210 --apply
//   node scripts/repairConvertedDealers.js --all --apply         # every owner without a trial,
//                                                                # not only converted WhatsApp agents
// Take a DB backup first.

require('dotenv').config();
const knexConfig = require('../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { planTrialRepair, grantMissingTrial } = require('../src/services/dealerOnboardingService');
const { normalizePhone } = require('../src/utils/phone');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const phoneArg = args.includes('--phone') ? normalizePhone(args[args.indexOf('--phone') + 1]) : null;

(async () => {
  let q = knex('users').where({ role: 'owner' }).whereNull('trial_ends_at');
  // Converted WhatsApp agents keep their old placeholder login (agent.<digits>@...).
  if (!ALL) q = q.where('email', 'like', 'agent.%@wa-signup.plotra.internal');
  if (phoneArg) q = q.where({ phone: phoneArg });
  const users = await q.select('id', 'name', 'phone', 'role', 'tenant_id', 'trial_ends_at', 'can_add_listing', 'package_id', 'selected_plan_key');
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'}: ${users.length} dealer(s) without a trial`);

  let fixed = 0; let skipped = 0; let failed = 0;
  for (const user of users) {
    try {
      await knex.transaction(async (trx) => {
        if (!APPLY) {
          const paid = await trx('payment_submissions').where({ agent_id: user.id, status: 'approved' }).first('id');
          const plan = planTrialRepair(user, { hasApprovedPayment: Boolean(paid) });
          console.log(`${plan.needsTrial ? 'would start a trial for' : 'would leave alone (already paid)'}: ${user.name} (${user.phone})`);
          plan.needsTrial ? fixed++ : skipped++;
          return;
        }
        const r = await grantMissingTrial(trx, user);
        console.log(`${r.needsTrial ? `trial until ${new Date(r.trialEndsAt).toISOString().slice(0, 10)}` : 'left alone (already paid)'}: ${user.name} (${user.phone})${r.planFixed ? ' [plan fixed]' : ''}`);
        r.needsTrial ? fixed++ : skipped++;
      });
    } catch (err) {
      console.error(`FAILED for ${user.name} (${user.phone}): ${err.message}`);
      failed++;
    }
  }
  console.log(`Done: ${fixed} ${APPLY ? 'repaired' : 'to repair'}, ${skipped} left alone, ${failed} failed.${APPLY ? '' : ' Run again with --apply to make the changes.'}`);
  await knex.destroy();
  process.exit(failed ? 1 : 0);
})();
