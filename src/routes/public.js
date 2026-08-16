const express = require('express');
const router = express.Router();
const { getPublicListing, logVisit, capturePublicLead } = require('../controllers/publicListingController');
const { getPublicBuilderProfile } = require('../controllers/builderProfileController');
const { submitAccessRequest } = require('../controllers/adminController');
// Phase 6 — monetization
const { executeRentVsBuyCalculation } = require('../controllers/calculatorController');
const { fetchTargetedAdPlacements, recordAdMetricEvent } = require('../controllers/adController');
// Phase 7 — billing + rate limiting
const { getPlans } = require('../controllers/billingController');
const { publicWriteLimiter, publicReadLimiter } = require('../middleware/rateLimiter');

router.get('/ping', (req, res) => res.json({ message: 'Public API is live' }));

/**
 * @route   GET /api/v1/public/listings/:slug
 * @desc    Expose verified public layout data frames for external map tracking
 * @access  Public
 */
router.get('/listings/:slug', publicReadLimiter, getPublicListing);

/**
 * @route   POST /api/v1/public/listings/:slug/visit
 * @desc    Log a page view against a listing (Phase 3 — anonymous by default)
 * @access  Public
 */
router.post('/listings/:slug/visit', publicWriteLimiter, logVisit);

/**
 * @route   POST /api/v1/public/listings/:slug/lead
 * @desc    Soft phone-number capture; creates/dedupes a lead, opens a WhatsApp
 *          thread, and queues the first-touch message (Phase 3 + Phase 4)
 * @access  Public
 */
router.post('/listings/:slug/lead', publicWriteLimiter, capturePublicLead);

/**
 * @route   GET /api/v1/public/listings/:slug/builder-profile
 * @desc    Buyer-facing builder due-diligence sheet (delivery history,
 *          leadership, financial condition, legal issues) — only returned
 *          once a human has published it, never on research completion alone
 * @access  Public
 */
router.get('/listings/:slug/builder-profile', publicReadLimiter, getPublicBuilderProfile);

/**
 * @route   POST /api/v1/public/request-access
 * @desc    Prospective tenants submit an onboarding request for admin review
 * @access  Public
 */
router.post('/request-access', publicWriteLimiter, submitAccessRequest);

/**
 * @route   POST /api/v1/public/tools/rent-vs-buy
 * @desc    Self-serve rent-vs-buy financial calculator (Phase 6)
 * @access  Public
 */
router.post('/tools/rent-vs-buy', publicWriteLimiter, executeRentVsBuyCalculation);

/**
 * @route   GET /api/v1/public/ads/serve
 * @desc    Serve matching active ad placements by position/city (Phase 6)
 * @access  Public
 */
router.get('/ads/serve', publicReadLimiter, fetchTargetedAdPlacements);

/**
 * @route   POST /api/v1/public/ads/:id/event
 * @desc    Record an impression/click/lead telemetry event for an ad (Phase 6)
 * @access  Public
 */
router.post('/ads/:id/event', publicWriteLimiter, recordAdMetricEvent);

/**
 * @route   GET /api/v1/public/billing/plans
 * @desc    List plans + pricing — powers the landing page pricing table (Phase 7)
 * @access  Public
 */
router.get('/billing/plans', getPlans);

module.exports = router;
