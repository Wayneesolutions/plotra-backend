const express = require('express');
const router = express.Router();
const authGuard = require('../middleware/auth');
const tenantTransaction = require('../middleware/tenantTransaction');
const { createListing, getListings, updateListing, deleteListing, getResolvedLocalities } = require('../controllers/listingController');
const { getDashboardAnalytics } = require('../controllers/analyticsController');
const { getLeads, updateLeadStatus } = require('../controllers/leadsController');
const { updateListingBoundary } = require('../controllers/listingBoundaryController');
const { linkOrCreateBuilderProfile, moderateBuilderProfile } = require('../controllers/builderProfileController');
const { inviteTenantUser, listTenantUsers, updateTenantUser } = require('../controllers/userInviteController');
const { listAgentSignups, approveAgentSignup, rejectAgentSignup } = require('../controllers/agentSignupController');
const { getWebChatCode, regenerateWebChatCode } = require('../controllers/webChatCodeController');
const { createCheckoutSessionHandler, cancelSubscriptionHandler, getBillingStatus } = require('../controllers/billingController');
const { uploadMiddleware, getListingMedia, uploadListingPhoto, deleteListingPhoto } = require('../controllers/mediaController');
const { getWhatsappNumbers, postWhatsappNumber, deleteWhatsappNumber, patchWhatsappNumberDefault } = require('../controllers/tenantWhatsappNumberController');
// NEW — internal ops panel (leads/WhatsApp inbox, document verification, AI call log, site visits)
// getLeads aliased to getOpsLeadInbox: leadsController.js's getLeads (tenant-wide
// lead list, mounted at /leads below) and dealerOpsController.js's getLeads
// (ops-panel WhatsApp lead inbox, mounted at /ops/leads) are two different
// functions that happen to share a name — a real name collision introduced
// by merging PR #4 and PR #5 together (each was fine on its own; neither
// had been tested against the other before this merge).
const {
  getOverview, getLeads: getOpsLeadInbox, getLeadMessages,
  getDocuments, updateDocumentStatus,
  getCalls, getVisits, updateVisit,
  triggerOutboundCall,
} = require('../controllers/dealerOpsController');

// tenantTransaction must come after authGuard (needs req.user.tenant_id) and
// wraps the controller in a single DB transaction with SET LOCAL tenant context
// for RLS enforcement.

/**
 * @route   POST /api/v1/dashboard/listings
 * @desc    Create a new real estate property asset and dispatch maps caching jobs
 * @access  Protected (Requires active Dealer/Agent Auth Bearer token)
 */
router.post('/listings', authGuard, tenantTransaction, createListing);

/**
 * @route   GET /api/v1/dashboard/listings
 * @desc    List all listings for the current tenant, with a visit_count per listing
 * @access  Protected (Requires active Dealer/Agent Auth Bearer token)
 */
router.get('/listings', authGuard, tenantTransaction, getListings);
router.get('/resolved-localities', authGuard, tenantTransaction, getResolvedLocalities);

/**
 * @route   PATCH /api/v1/dashboard/listings/:id
 * @desc    Edit a listing's fields and/or status (active/inactive/sold)
 * @access  Protected
 */
router.patch('/listings/:id', authGuard, tenantTransaction, updateListing);

/**
 * @route   DELETE /api/v1/dashboard/listings/:id
 * @desc    Permanently delete a listing
 * @access  Protected
 */
router.delete('/listings/:id', authGuard, tenantTransaction, deleteListing);

/**
 * @route   PATCH /api/v1/dashboard/listings/:id/boundary
 * @desc    Save a traced plot boundary (GeoJSON) for a listing
 * @access  Protected
 */
router.patch('/listings/:id/boundary', authGuard, tenantTransaction, updateListingBoundary);

/**
 * @route   POST /api/v1/dashboard/listings/:id/builder-profile
 * @desc    Link a listing to a builder company (creating + researching it if new)
 * @access  Protected
 */
router.post('/listings/:id/builder-profile', authGuard, tenantTransaction, linkOrCreateBuilderProfile);

/**
 * @route   PATCH /api/v1/dashboard/builder-profiles/:id/moderation
 * @desc    Publish/reject a builder profile's AI-researched claims — owner only.
 *          Required before any claim about this builder is shown to buyers.
 * @access  Protected (owner role)
 */
router.patch('/builder-profiles/:id/moderation', authGuard, tenantTransaction, moderateBuilderProfile);

/**
 * @route   GET /api/v1/dashboard/analytics
 * @desc    Fetch aggregated real estate traffic metrics, lead capture metrics, and recent activity
 * @access  Protected (Requires Active Agent/Owner Bearer Token)
 */
router.get('/analytics', authGuard, tenantTransaction, getDashboardAnalytics);

/**
 * @route   GET /api/v1/dashboard/leads
 * @desc    List every captured lead for the tenant (optionally filtered by
 *          ?status=), each enriched with a 0-100 score and its most recent
 *          listing. Fixes the gap where WhatsApp callback leads were saved
 *          (see publicListingController.capturePublicLead) but never
 *          surfaced anywhere in the dashboard.
 * @access  Protected
 */
router.get('/leads', authGuard, tenantTransaction, getLeads);

/**
 * @route   PATCH /api/v1/dashboard/leads/:id/status
 * @desc    Update a lead's status (new/contacted/qualified/closed/lost)
 * @access  Protected
 */
router.patch('/leads/:id/status', authGuard, tenantTransaction, updateLeadStatus);

/**
 * @route   POST /api/v1/dashboard/users/invite
 * @desc    Invite a second user (agent) under the same tenant — owner only
 * @access  Protected (owner role)
 */
router.post('/users/invite', authGuard, tenantTransaction, inviteTenantUser);

/**
 * @route   GET /api/v1/dashboard/users
 * @desc    List this tenant's team members — powers the "assign to"
 *          dropdown for per-listing WhatsApp attribution
 * @access  Protected
 */
router.get('/users', authGuard, tenantTransaction, listTenantUsers);

/**
 * @route   PATCH /api/v1/dashboard/users/:id
 * @desc    Add/change a team member's phone (WhatsApp listing intake) after
 *          creation — owner only, scoped to the owner's own tenant
 * @access  Protected (owner role)
 */
router.patch('/users/:id', authGuard, tenantTransaction, updateTenantUser);

/**
 * @route   GET /api/v1/dashboard/agent-signups
 * @desc    List this tenant's pending, fully-collected "join as agent"
 *          self-registration requests — owner only
 * @route   POST /api/v1/dashboard/agent-signups/:id/approve
 * @desc    Approve a request — creates the real users row (role='agent'),
 *          immediately live for WhatsApp agent-intake
 * @route   POST /api/v1/dashboard/agent-signups/:id/reject
 * @desc    Reject a request
 * @access  Protected (owner role)
 */
router.get('/agent-signups', authGuard, tenantTransaction, listAgentSignups);
router.post('/agent-signups/:id/approve', authGuard, tenantTransaction, approveAgentSignup);
router.post('/agent-signups/:id/reject', authGuard, tenantTransaction, rejectAgentSignup);

/**
 * @route   GET /api/v1/dashboard/web-chat-code
 * @desc    This tenant's web chat widget activation code (generated on
 *          first request if not already set) — owner only
 * @route   POST /api/v1/dashboard/web-chat-code/regenerate
 * @desc    Rotate the code
 * @access  Protected (owner role)
 */
router.get('/web-chat-code', authGuard, tenantTransaction, getWebChatCode);
router.post('/web-chat-code/regenerate', authGuard, tenantTransaction, regenerateWebChatCode);

/**
 * @route   GET  /api/v1/dashboard/listings/:id/media
 * @desc    Get photo_urls for a listing
 * @route   POST /api/v1/dashboard/listings/:id/media
 * @desc    Upload a photo to S3 and append the URL to the listing's photo_urls
 * @route   DELETE /api/v1/dashboard/listings/:id/media
 * @desc    Remove a photo from S3 and from the listing's photo_urls
 */
router.get('/listings/:id/media', authGuard, tenantTransaction, getListingMedia);
router.post('/listings/:id/media', authGuard, uploadMiddleware, tenantTransaction, uploadListingPhoto);
router.delete('/listings/:id/media', authGuard, tenantTransaction, deleteListingPhoto);

/**
 * BUG FIX: these two billing routes previously had authGuard but NOT
 * tenantTransaction — they queried via the raw connection pool with no
 * tenant context set at all. Under the old permissive RLS (allow
 * everything when no context is set) this happened to still be safe only
 * because of the app-layer .where({tenant_id}) clauses already in the
 * controller. Under the new default-deny RLS, missing tenantTransaction
 * here would make these routes return zero rows instead of the tenant's
 * actual billing data. Added for correctness and consistency with every
 * other tenant-scoped route.
 */
router.post('/billing/create-checkout-session', authGuard, tenantTransaction, createCheckoutSessionHandler);
router.post('/billing/cancel-subscription', authGuard, tenantTransaction, cancelSubscriptionHandler);
router.get('/billing/status', authGuard, tenantTransaction, getBillingStatus);

/**
 * NEW — Ops panel routes. Backs the internal admin panel: overview stats,
 * WhatsApp lead inbox, document verification queue, AI call log, site visits.
 * Same authGuard + tenantTransaction pattern as every other dashboard route.
 */
router.get('/ops/overview', authGuard, tenantTransaction, getOverview);
router.get('/ops/leads', authGuard, tenantTransaction, getOpsLeadInbox);
router.get('/ops/leads/:id/messages', authGuard, tenantTransaction, getLeadMessages);
router.get('/ops/documents', authGuard, tenantTransaction, getDocuments);
router.patch('/ops/documents/:id', authGuard, tenantTransaction, updateDocumentStatus);
router.get('/ops/calls', authGuard, tenantTransaction, getCalls);
router.post('/ops/leads/:id/call', authGuard, tenantTransaction, triggerOutboundCall);
router.get('/ops/visits', authGuard, tenantTransaction, getVisits);
router.patch('/ops/visits/:id', authGuard, tenantTransaction, updateVisit);

/**
 * NEW — tenant WhatsApp number management (Part 2, build-order item 4).
 * Owner-only (enforced in the controller, same pattern as /users/invite).
 * Adding is capped by plans.max_whatsapp_numbers.
 */
router.get('/whatsapp-numbers', authGuard, tenantTransaction, getWhatsappNumbers);
router.post('/whatsapp-numbers', authGuard, tenantTransaction, postWhatsappNumber);
router.delete('/whatsapp-numbers/:id', authGuard, tenantTransaction, deleteWhatsappNumber);
router.patch('/whatsapp-numbers/:id/default', authGuard, tenantTransaction, patchWhatsappNumberDefault);

module.exports = router;
