const bcrypt = require('bcryptjs');

/**
 * Phase 0 Seed: Populates initial core tenancy and master administrative agent records
 */
exports.seed = async function(knex) {
  // 1. Clear out existing records in reverse FK dependency order
  await knex('whatsapp_messages').del();
  await knex('whatsapp_threads').del();
  await knex('listing_visits').del();
  await knex('listing_landmarks').del();
  await knex('listing_media').del();
  await knex('leads').del();
  await knex('listings').del();
  await knex('tenant_requests').del();
  await knex('tenant_configs').del();
  await knex('users').del();
  await knex('tenants').del();

  // 2. Generate a deterministic, immutable UUID string for our primary tenant context
  const targetTenantId = 'e2b0a178-523c-4a37-bba2-58807d9f75a2';

  // 3. Inject Master Tenant Boundary
  await knex('tenants').insert({
    id: targetTenantId,
    business_name: 'Wayne E Solutions',
    plan: 'unlimited',
    whatsapp_mode: 'shared',
    status: 'active',
    created_at: knex.fn.now(),
    updated_at: knex.fn.now()
  });

  // 4. Compute safe salted hash matching security constraints
  // In production, this hashing step happens inside your registration/management service layer
  const saltRounds = 10;
  const plaintextPassword = 'Password123!';
  const hashedPassword = await bcrypt.hash(plaintextPassword, saltRounds);

  // 5. Inject Primary Administrative Agent
  await knex('users').insert({
    id: knex.raw('uuid_generate_v4()'),
    tenant_id: targetTenantId,
    name: 'Pankaj Administrator',
    email: 'admin@wayneesolutions.com',
    password_hash: hashedPassword,
    role: 'super_admin',
    created_at: knex.fn.now(),
    updated_at: knex.fn.now()
  });

  // 6. Set up System Configuration Parameters mapping for Google Maps & WhatsApp channels
  await knex('tenant_configs').insert({
    id: knex.raw('uuid_generate_v4()'),
    tenant_id: targetTenantId,
    bsp_provider_type: 'shared_gateway',
    bsp_auth_token: null, // Populated via configuration panel inputs later
    created_at: knex.fn.now(),
    updated_at: knex.fn.now()
  });

  console.log('Successfully completed Phase 0 system database seed sequence.');
  console.log('-> Tenant Configured: Wayne E Solutions');
  console.log('-> Authorized Agent Login: admin@wayneesolutions.com / Password123!');
};