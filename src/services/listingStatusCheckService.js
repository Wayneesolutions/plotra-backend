// src/services/listingStatusCheckService.js
//
// Monthly listing status check + auto-delete (PR 4). Shared between the
// daily cron (listingStatusCheckWorker.js) and the WhatsApp button-reply
// handler (webhookController.js) so cycle-day math lives in exactly one
// place, same reasoning as PR 2's agentPaymentService.js.
const { enqueueAgentWhatsappSend, logAgentOutboundMessage } = require('./agentMessagingService');

const REMINDER_AFTER_DAYS = 3;
const UNCONFIRMED_AFTER_DAYS = 7;
const CYCLE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(date) {
  return Math.floor((Date.now() - new Date(date).getTime()) / DAY_MS);
}

/**
 * Who gets the status-check message for a listing — the growth+ plan
 * "dedicated buyer contact" (assigned_agent_id) if the dealer set one,
 * otherwise whoever actually created the listing (created_by). Most
 * listings only ever have created_by; assigned_agent_id exists
 * specifically so a listing's dedicated contact (who's presumably closer
 * to its actual sale status) is asked instead when a dealer has set one.
 */
async function getResponsibleAgent(knex, listing) {
  const agentId = listing.assigned_agent_id || listing.created_by;
  if (!agentId) return null;
  return knex('users').where({ id: agentId }).first();
}

function buildButtons(listingId) {
  return [
    { id: `available:${listingId}`, title: 'Still Available' },
    { id: `sold:${listingId}`, title: 'Sold' },
  ];
}

async function sendStatusCheckPrompt(knex, listing, { isReminder = false } = {}) {
  const agent = await getResponsibleAgent(knex, listing);
  if (!agent) return false;

  const body = isReminder
    ? `⏰ Reminder: is "${listing.title}" still for sale? Please confirm below.`
    : `📋 Quick check-in: is "${listing.title}" still for sale?`;

  await enqueueAgentWhatsappSend({
    tenantId: listing.tenant_id,
    phone: agent.phone,
    messageBody: body,
    buttons: buildButtons(listing.id),
  });

  const updates = isReminder
    ? { status_check_reminder_sent_at: knex.fn.now() }
    : { status_check_sent_at: knex.fn.now(), status_check_reminder_sent_at: null };
  await knex('listings').where({ id: listing.id }).update({ ...updates, updated_at: knex.fn.now() });

  return true;
}

/**
 * Agent replied "Still Available" — bump last_confirmed_at, nothing else
 * changes (per spec: "no other change"). Doesn't require the reply to be
 * for the CURRENT cycle's prompt specifically — a late confirmation still
 * counts and stops the reminder/unconfirmed escalation for whatever cycle
 * is in progress.
 */
async function handleStillAvailableConfirmation(knex, { listingId, agentUser }) {
  const listing = await knex('listings').where({ id: listingId }).first();
  if (!listing) return false;

  await knex('listings').where({ id: listingId }).update({
    last_confirmed_at: knex.fn.now(),
    // Clears an 'unconfirmed' flag from a prior cycle, if this reply
    // arrived after that flag was set — status returns to 'active'.
    status: listing.status === 'unconfirmed' ? 'active' : listing.status,
    updated_at: knex.fn.now(),
  });

  const body = '✅ Thanks — marked as still available.';
  await enqueueAgentWhatsappSend({ tenantId: listing.tenant_id, phone: agentUser.phone, messageBody: body });
  return true;
}

/**
 * Agent replied "Sold" — soft-delete: status='sold', deleted_at=now().
 * Spec's own recommendation, confirmed with the user before implementing
 * (see PR description) — keeps a record for analytics/undo instead of a
 * hard DELETE, which nothing else in this codebase does to a listings row
 * either. Dropping out of "active" is automatic: every existing query that
 * filters status='active' (public listing pages, admin listings, the
 * marketplace search in buyerSearchService.js, and PR 5's forthcoming
 * duplicate-address check) already excludes anything not literally
 * 'active' — no other file needs to change for this listing to disappear
 * from active view.
 */
async function handleSoldConfirmation(knex, { listingId, agentUser }) {
  const listing = await knex('listings').where({ id: listingId }).first();
  if (!listing) return false;

  await knex('listings').where({ id: listingId }).update({
    status: 'sold',
    deleted_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });

  const body = '🎉 Congratulations on the sale! This listing has been marked sold and removed from public view.';
  await enqueueAgentWhatsappSend({ tenantId: listing.tenant_id, phone: agentUser.phone, messageBody: body });
  return true;
}

/**
 * One daily pass over every active listing. Exported separately from the
 * Worker handler for the same testability reason as PR 2's
 * processReminderCycle.
 */
async function processMonthlyStatusChecks(knex) {
  const listings = await knex('listings').where({ status: 'active' }).whereNull('deleted_at');

  let checksSent = 0;
  let remindersSent = 0;
  let flaggedUnconfirmed = 0;

  for (const listing of listings) {
    const daysSinceCreation = daysSince(listing.created_at);
    if (daysSinceCreation < CYCLE_DAYS) continue; // not due for a first check yet

    // Per-cycle anchor: the last time we actually sent a fresh check, or
    // created_at if we never have. Re-derived, not stored as a separate
    // cycle number — a new 30-day window opens exactly CYCLE_DAYS after
    // the anchor, recurring indefinitely (spec: "not a one-time check").
    const anchor = listing.status_check_sent_at || listing.created_at;
    const daysSinceAnchor = daysSince(anchor);

    if (!listing.status_check_sent_at || daysSinceAnchor >= CYCLE_DAYS) {
      const sent = await sendStatusCheckPrompt(knex, listing);
      if (sent) checksSent++;
      continue; // fresh cycle just started — nothing else to evaluate this run
    }

    const answeredThisCycle = listing.last_confirmed_at
      && new Date(listing.last_confirmed_at) >= new Date(listing.status_check_sent_at);
    if (answeredThisCycle) continue;

    if (daysSinceAnchor >= REMINDER_AFTER_DAYS && !listing.status_check_reminder_sent_at) {
      const sent = await sendStatusCheckPrompt(knex, listing, { isReminder: true });
      if (sent) remindersSent++;
    }

    if (daysSinceAnchor >= UNCONFIRMED_AFTER_DAYS && listing.status !== 'unconfirmed') {
      // Flag only — never auto-delete without a confirmed "Sold" reply
      // (spec, explicit). This function's own WHERE clause only ever
      // selects status='active' listings, so once flagged 'unconfirmed'
      // this listing stops getting new automated prompts from future cron
      // runs — matches the spec's "recurring... for as long as the
      // listing is active" (it no longer is, once flagged). It isn't
      // stuck silently forever though: a late reply still works
      // (handleStillAvailableConfirmation/handleSoldConfirmation below are
      // reachable regardless of current status and restore 'active' on a
      // late "Still Available"), and a dealer can always reset it back to
      // 'active' from the dashboard to resume the cycle. If continuing to
      // re-prompt an unconfirmed listing every 30 days (rather than
      // waiting on a human) turns out to be preferred, remove the
      // status!=='unconfirmed' filter above the main loop query instead.
      await knex('listings').where({ id: listing.id }).update({ status: 'unconfirmed', updated_at: knex.fn.now() });
      flaggedUnconfirmed++;
    }
  }

  return { listingsChecked: listings.length, checksSent, remindersSent, flaggedUnconfirmed };
}

module.exports = {
  processMonthlyStatusChecks,
  handleStillAvailableConfirmation,
  handleSoldConfirmation,
  getResponsibleAgent,
};
