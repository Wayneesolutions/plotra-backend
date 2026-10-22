// src/services/dealerOnboardingService.js
//
// Plotraa has three kinds of people (21 Oct 2026 decision):
//   - dealer      a business on Plotraa, with its own admin panel. Stored as
//                 its own tenant + a users row with role 'owner'.
//   - sub-dealer  created by a dealer from their admin panel (role 'agent'
//                 inside the dealer's tenant).
//   - customer    buyers/sellers, no login.
//   - super admin the Plotraa team.
// "Tenant" is only the database word for a dealer's own space; nobody sees it.
//
// Before this, everyone who joined on WhatsApp was approved as an 'agent'
// inside one shared tenant (Wayne E Solutions), so they had no panel of their
// own and leads forwarded to "a dealer" never reached them. Now every
// approved WhatsApp joiner becomes a new dealer: new tenant, owner user,
// 7-day free trial, and a set-password link instead of a plain password.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { normalizePhone } = require('../utils/phone');
const { validateCityChoice, setTenantCities, CityValidationError } = require('./tenantCityService');
const { resolveCityBounds } = require('./geoBiasService');

const TRIAL_DAYS = Number(process.env.DEALER_TRIAL_DAYS) || 7;
// Plan a new dealer runs on during the trial: needs the dashboard (admin
// panel to add sub-dealers). The super admin changes it after payment.
const TRIAL_PLAN = process.env.DEALER_TRIAL_PLAN || 'multi_user_basic';
const SETUP_LINK_TTL_HOURS = Number(process.env.SETUP_LINK_TTL_HOURS) || 7 * 24;
const DAY_MS = 24 * 60 * 60 * 1000;

function publicAppUrl() {
  return process.env.PUBLIC_APP_URL || 'https://plotraa.com';
}

/** Pure: placeholder login email for a WhatsApp-only user (users.email is NOT NULL UNIQUE). */
function placeholderEmail(phone, prefix = 'dealer') {
  return `${prefix}.${String(phone).replace(/\D/g, '')}@wa-signup.plotra.internal`;
}

/** Pure: is this one of our placeholder emails (never shown as a login id)? */
function isPlaceholderEmail(email) {
  return /@wa-signup\.plotra\.internal$/i.test(String(email || ''));
}

/** Pure: trial end date from the approval time. */
function trialEndsAt(from = new Date(), days = TRIAL_DAYS) {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Mints a one-time "set your password" link (same token table and page as
 * forgot-password, longer validity). Returns the URL; only the hash is stored.
 */
async function createSetPasswordLink(knex, userId, { ttlHours = SETUP_LINK_TTL_HOURS } = {}) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await knex('password_reset_tokens').insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
  });
  return `${publicAppUrl()}/reset-password?token=${rawToken}&setup=1`;
}

/** An unguessable password nobody knows: the user sets their own via the link. */
async function unusablePasswordHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
}

/**
 * Cities for a new dealer: the ones the admin picked, else the cities named
 * in what they told us (working area), else the oldest live city (the
 * launch city). Throws CityValidationError only if none exists at all.
 */
async function chooseDealerCities(knex, { cityIds, primaryCityId, areaText }) {
  if (Array.isArray(cityIds) && cityIds.length) return validateCityChoice(knex, { cityIds, primaryCityId });
  const cities = await knex('cities').whereNot({ status: 'disabled' }).whereNotNull('code')
    .orderBy('created_at', 'asc').select('id', 'name', 'status');
  const text = String(areaText || '');
  const named = cities.filter((c) => new RegExp(`\\b${String(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  const pick = named.length ? named : cities.filter((c) => c.status === 'live').slice(0, 1);
  if (!pick.length && cities.length) pick.push(cities[0]);
  if (!pick.length) throw new CityValidationError('CITY_REQUIRED', 'Add a city in Cities & Areas first.');
  return validateCityChoice(knex, { cityIds: pick.map((c) => c.id), primaryCityId: pick[0].id });
}

/**
 * Creates a dealer from an approved WhatsApp signup. `signup` is the
 * pending_agent_signups row. Returns { tenant, user, setupUrl, trialEndsAt }.
 * Throws { code: 'DUPLICATE_PHONE' } if the phone already has an account.
 */
async function createDealerFromSignup(knex, signup, { cityIds, primaryCityId, businessName, now = new Date() } = {}) {
  const phone = normalizePhone(signup.phone);
  const taken = await knex('users').where({ phone }).first('id');
  if (taken) {
    const err = new Error('This phone number already has an account.');
    err.code = 'DUPLICATE_PHONE';
    throw err;
  }

  const cityChoice = await chooseDealerCities(knex, { cityIds, primaryCityId, areaText: signup.address });
  // Real HTTP call to Google: done before the transaction opens.
  let geoBiasBounds = null;
  try {
    geoBiasBounds = await resolveCityBounds(cityChoice.primaryCity.name, cityChoice.primaryCity.state);
  } catch (err) {
    console.error('[dealerOnboarding] city bounds lookup failed (non-fatal):', err.message);
  }
  const passwordHash = await unusablePasswordHash();
  const endsAt = trialEndsAt(now);

  let tenant; let user; let setupUrl;
  await knex.transaction(async (trx) => {
    [tenant] = await trx('tenants').insert({
      business_name: String(businessName || signup.name || 'Dealer').slice(0, 255),
      plan: TRIAL_PLAN,
      whatsapp_mode: 'shared',
      status: 'active',
    }).returning(['id', 'business_name', 'plan', 'status']);

    tenant.cities = await setTenantCities(trx, tenant.id, cityChoice);

    [user] = await trx('users').insert({
      tenant_id: tenant.id,
      name: signup.name,
      email: placeholderEmail(phone),
      password_hash: passwordHash,
      role: 'owner',
      phone,
      onboarded_at: now,
      trial_ends_at: endsAt,
      can_add_listing: true,
    }).returning(['id', 'name', 'email', 'phone', 'role', 'tenant_id']);

    await trx('tenant_configs').insert({
      tenant_id: tenant.id,
      bsp_provider_type: 'shared_gateway',
      bsp_auth_token: null,
      geo_bias_bounds: geoBiasBounds,
    });

    await trx('pending_agent_signups').where({ id: signup.id })
      .update({ status: 'approved', updated_at: trx.fn.now() });

    setupUrl = await createSetPasswordLink(trx, user.id);
  });

  return { tenant, user, setupUrl, trialEndsAt: endsAt };
}

/**
 * Pure (unit-tested): what to do for a dealer account that was converted from
 * an old WhatsApp agent (or otherwise never got a trial). 22 Oct bug: those
 * dealers had no trial and a stale old package, so the monthly cycle had
 * already blocked them and assigning a lead failed with DEALER_UNPAID.
 *   user: { role, trial_ends_at, can_add_listing, package_id, selected_plan_key }
 *   hasApprovedPayment: they really paid before
 *   tenantPlanKnown: tenants.plan exists in the plans table
 * Returns { needsTrial, patch (users), tenantPlan (or null = leave) }.
 */
function planTrialRepair(user, { hasApprovedPayment = false, tenantPlanKnown = true, now = new Date() } = {}) {
  if (!user || user.role !== 'owner' || user.trial_ends_at || hasApprovedPayment) {
    return { needsTrial: false, patch: {}, tenantPlan: tenantPlanKnown ? null : TRIAL_PLAN };
  }
  return {
    needsTrial: true,
    patch: {
      trial_ends_at: trialEndsAt(now),
      trial_reminder_day: null,
      can_add_listing: true,
      onboarded_at: now,
      payment_status: 'unpaid',
      package_id: null,
      selected_plan_key: null,
    },
    tenantPlan: tenantPlanKnown ? null : TRIAL_PLAN,
  };
}

/** Applies planTrialRepair to one user inside `trx`. Returns { needsTrial, trialEndsAt }. */
async function grantMissingTrial(trx, user, { now = new Date() } = {}) {
  const paid = await trx('payment_submissions').where({ agent_id: user.id, status: 'approved' }).first('id');
  const tenant = await trx('tenants').where({ id: user.tenant_id }).first('plan');
  const planKnown = tenant?.plan ? Boolean(await trx('plans').where({ key: tenant.plan }).first('key')) : false;
  const plan = planTrialRepair(user, { hasApprovedPayment: Boolean(paid), tenantPlanKnown: planKnown, now });
  if (plan.needsTrial) await trx('users').where({ id: user.id }).update({ ...plan.patch, updated_at: trx.fn.now() });
  if (plan.tenantPlan) await trx('tenants').where({ id: user.tenant_id }).update({ plan: plan.tenantPlan, updated_at: trx.fn.now() });
  return { needsTrial: plan.needsTrial, trialEndsAt: plan.needsTrial ? plan.patch.trial_ends_at : null, planFixed: Boolean(plan.tenantPlan) };
}

/** Pure: "28 Oct" style date for WhatsApp messages (India time). */
function shortDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/**
 * Pure: the WhatsApp welcome for a new dealer. Login id is their WhatsApp
 * number; the password is set through the link (never sent in the message).
 */
function buildDealerWelcomeMessage({ name, lang, phone, setupUrl, trialEnd }) {
  const until = trialEnd ? shortDate(trialEnd) : null;
  if (lang === 'en') {
    return [
      `✅ *Welcome to Plotraa, ${name}!* Your dealer account is approved.`,
      until ? `🎁 Your *7-day free trial* runs till *${until}*.` : null,
      '',
      '*Your first listing, in 3 steps:*',
      '1. Send the property details here: area, type, size, price (text or a voice note 🎤)',
      '2. Share the exact location 📍 when asked',
      '3. Check the preview link and reply *"yes"* to publish',
      '',
      `*Your admin panel* (add sub-dealers, see leads) at ${publicAppUrl()}:`,
      `📱 Login ID: ${phone}`,
      `🔑 Set your password here: ${setupUrl}`,
      '(This link works once and expires in 7 days.)',
    ].filter((l) => l !== null).join('\n');
  }
  return [
    `✅ *Plotraa mein swagat hai, ${name} ji!* Aapka dealer account approve ho gaya hai.`,
    until ? `🎁 Aapka *7 din ka free trial* *${until}* tak hai.` : null,
    '',
    '*Pehli listing, 3 steps mein:*',
    '1. Property ki details yahan bhejo: area, type, size, price (likh ke ya voice note 🎤)',
    '2. Pucchne pe exact location 📍 share karo',
    '3. Preview link check karke *"haan"* reply karo, listing live',
    '',
    `*Aapka admin panel* (sub-dealer add karo, leads dekho) ${publicAppUrl()} pe:`,
    `📱 Login ID: ${phone}`,
    `🔑 Password yahan set karo: ${setupUrl}`,
    '(Link ek baar chalega, 7 din tak valid hai.)',
  ].filter((l) => l !== null).join('\n');
}

/** Pure: WhatsApp message to a new sub-dealer added by their dealer. */
function buildSubDealerWelcomeMessage({ name, dealerName, phone, setupUrl }) {
  return [
    `✅ Namaste ${name} ji! *${dealerName}* ne aapko Plotraa pe sub-dealer add kiya hai.`,
    'Property ki details isi number se yahan bhejo, listing ban jayegi.',
    '',
    `Panel login (${publicAppUrl()}):`,
    `📱 Login ID: ${phone}`,
    `🔑 Password yahan set karo: ${setupUrl}`,
    '(Link ek baar chalega, 7 din tak valid hai.)',
  ].join('\n');
}

module.exports = {
  TRIAL_DAYS,
  TRIAL_PLAN,
  placeholderEmail,
  isPlaceholderEmail,
  trialEndsAt,
  createSetPasswordLink,
  unusablePasswordHash,
  chooseDealerCities,
  createDealerFromSignup,
  buildDealerWelcomeMessage,
  buildSubDealerWelcomeMessage,
  shortDate,
  planTrialRepair,
  grantMissingTrial,
};
