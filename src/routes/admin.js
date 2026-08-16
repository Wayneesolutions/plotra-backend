const express = require('express');
const router = express.Router();
const authGuard = require('../middleware/auth');
const adminGuard = require('../middleware/adminGuard');
const serviceContext = require('../middleware/serviceContext');
const {
  listRequests,
  approveRequest,
  rejectRequest,
  createTenant,
  listTenants,
  getTenantDetail,
  updateTenantStatus,
  updateTenantPlan,
} = require('../controllers/adminController');
const {
  listAdPlacements,
  createAdPlacement,
  updateAdPlacement,
} = require('../controllers/adminAdsController');
// NEW — plan management (gap #3)
const { listPlansAdmin, updatePlan, createPlan, deletePlan } = require('../controllers/plansController');

// Every admin route requires a valid JWT (authGuard), super_admin role
// (adminGuard), AND now serviceContext — these routes legitimately read/
// write across every tenant, which the default-deny RLS would otherwise
// block. adminGuard's role check is the real access control here, not
// tenant matching, so this is the intentional cross-tenant opt-in (same
// pattern as the webhook routes).
router.use(authGuard, adminGuard, serviceContext);

/**
 * @route   GET /api/v1/admin/requests
 * @desc    List all access requests; filter by ?status=pending|approved|rejected
 */
router.get('/requests', listRequests);

/**
 * @route   POST /api/v1/admin/requests/:id/approve
 * @desc    Approve a pending request — creates tenant + owner user + tenant_config
 */
router.post('/requests/:id/approve', approveRequest);

/**
 * @route   POST /api/v1/admin/requests/:id/reject
 * @desc    Reject a pending request
 */
router.post('/requests/:id/reject', rejectRequest);

/**
 * @route   GET /api/v1/admin/tenants
 * @desc    List all tenants with user counts
 */
router.get('/tenants', listTenants);

/**
 * @route   POST /api/v1/admin/tenants
 * @desc    Directly create a new tenant without a request
 */
router.post('/tenants', createTenant);

/**
 * @route   GET /api/v1/admin/tenants/:id
 * @desc    Tenant detail drill-down — owner, listings, and this-month usage.
 *          Fixes gap: clicking a tenant row previously did nothing.
 */
router.get('/tenants/:id', getTenantDetail);

/**
 * @route   PATCH /api/v1/admin/tenants/:id/status
 * @desc    Suspend / reactivate / mark churned
 */
router.patch('/tenants/:id/status', updateTenantStatus);

/**
 * @route   PATCH /api/v1/admin/tenants/:id/plan
 * @desc    Admin-side manual plan override
 */
router.patch('/tenants/:id/plan', updateTenantPlan);

/**
 * @route   GET /api/v1/admin/ads
 * @desc    List all ad placements with lifetime impression/click counts
 */
router.get('/ads', listAdPlacements);

/**
 * @route   POST /api/v1/admin/ads
 * @desc    Create a new ad placement
 */
router.post('/ads', createAdPlacement);

/**
 * @route   PATCH /api/v1/admin/ads/:id
 * @desc    Update an ad placement (toggle is_active, fix a URL, extend dates, etc.)
 */
router.patch('/ads/:id', updateAdPlacement);

/**
 * @route   GET /api/v1/admin/plans
 * @desc    List every plan (including inactive) for admin editing
 */
router.get('/plans', listPlansAdmin);

/**
 * @route   POST /api/v1/admin/plans
 * @desc    Create a new plan tier
 */
router.post('/plans', createPlan);

/**
 * @route   PATCH /api/v1/admin/plans/:key
 * @desc    Update a plan's price, listing limit, features, or active status
 */
router.patch('/plans/:key', updatePlan);

/**
 * @route   DELETE /api/v1/admin/plans/:key
 * @desc    Delete a plan — blocked if any tenants are currently on it
 */
router.delete('/plans/:key', deletePlan);

module.exports = router;
