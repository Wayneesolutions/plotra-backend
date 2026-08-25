/**
 * Part 3 — WhatsApp self-serve onboarding for Tier 1. Reuses the existing
 * tenant_requests approve/reject system as the underlying model (per the
 * brief: "this just adds a new entry point into it") rather than building
 * a parallel review flow, plus one new table for the multi-turn
 * conversation state a WhatsApp signup needs that a one-shot web form
 * never did.
 */

exports.up = async function (knex) {
  // email is NOT NULL today (every existing requester came through the web
  // form, which always has one) — the WhatsApp flow never asks for an
  // email at all. Relaxed here; submitAccessRequest's own application-level
  // check ("business_name, contact_name, email, and phone are required")
  // still enforces it for the web-form path, this is only for whatsapp-
  // source rows.
  await knex.schema.alterTable('tenant_requests', (table) => {
    table.string('email', 255).nullable().alter();
  });

  await knex.schema.alterTable('tenant_requests', (table) => {
    // 'web_form' (existing flow, default) | 'whatsapp' (this one). Lets the
    // admin requests list/UI distinguish them without a second table.
    table.string('source', 20).notNullable().defaultTo('web_form');

    // The number to actually activate on approval — asked for explicitly
    // in the WhatsApp flow since the sender's own number isn't assumed to
    // be the same one they want live on Plotra. Null for web_form requests
    // (phone already covers "how to reach this prospect" there).
    table.string('requested_whatsapp_number', 20).nullable();

    // Which plan this request is for. Always 'tier1' for the WhatsApp flow
    // today (that's the only self-serve tier — Tier 2/3 still go through
    // the existing web-form + manual plan assignment), but stored rather
    // than hardcoded so a future self-serve Tier 2/3 flow doesn't need a
    // schema change.
    table.string('requested_plan', 30).nullable();

    // Payment gate, WhatsApp-flow only: qr_sent -> paid_qr, or
    // cash_pending -> paid_cash. Unlike the web-form flow (where "approve"
    // = tenant is live), a WhatsApp signup's tenant is created at approval
    // time in status='pending_payment' — see adminController.js's
    // approveRequest — and only actually activated once this reaches a
    // paid_* state (confirmSignupPayment). tenant_id links the two steps.
    table.string('payment_status', 20).nullable();
    table.uuid('payment_confirmed_by').nullable().references('id').inTable('users');
    table.timestamp('payment_confirmed_at').nullable();
    table.uuid('tenant_id').nullable().references('id').inTable('tenants');
  });

  await knex.schema.createTable('whatsapp_signup_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('phone', 20).notNullable().unique();

    // new (just started, welcome sent) -> collecting_name -> collecting_area
    // -> collecting_number -> confirming -> submitted (a tenant_requests row
    // now exists, awaiting admin review) -> awaiting_payment (admin
    // approved, payment link sent) -> completed (payment confirmed, tenant
    // activated) | abandoned.
    table.string('state', 30).notNullable().defaultTo('new');

    table.string('collected_name', 255).nullable();
    table.string('collected_area', 255).nullable();
    table.string('collected_number', 20).nullable();

    table.uuid('tenant_request_id').nullable().references('id').inTable('tenant_requests');

    table.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('whatsapp_signup_sessions');
  await knex.schema.alterTable('tenant_requests', (table) => {
    table.dropColumn('source');
    table.dropColumn('requested_whatsapp_number');
    table.dropColumn('requested_plan');
    table.dropColumn('payment_status');
    table.dropColumn('payment_confirmed_by');
    table.dropColumn('payment_confirmed_at');
    table.dropColumn('tenant_id');
  });
};
