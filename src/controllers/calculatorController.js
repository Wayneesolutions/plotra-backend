const { calculateRentVsBuyMetrics } = require('../utils/rentVsBuyCalculator');

/**
 * POST /api/v1/public/tools/rent-vs-buy
 * Public — no auth. Used from the property page calculator widget.
 *
 * tenantId/propertyId are optional context (passed by the frontend when the
 * calculator is opened from a specific listing) purely for later reporting —
 * the calculation itself doesn't depend on them.
 */
async function executeRentVsBuyCalculation(req, res) {
  const knex = req.app.get('db');

  const {
    city = 'Ludhiana',
    state = 'Punjab',
    propertyPrice,
    downPaymentPercent = 20,
    interestRate,
    tenureYears = 20,
    comparableRentMonthly,
    taxDeductionToggle = true,
    propertyId = null,
    tenantId = null,
  } = req.body;

  const numericPropertyPrice = Number(propertyPrice);
  const numericInterestRate = Number(interestRate);
  const numericRentMonthly = Number(comparableRentMonthly);
  const numericDownPaymentPercent = Number(downPaymentPercent);
  const numericTenureYears = Number(tenureYears);

  if (!propertyPrice || !interestRate || !comparableRentMonthly) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'propertyPrice, interestRate, and comparableRentMonthly are required.' }
    });
  }

  if (!Number.isFinite(numericPropertyPrice) || numericPropertyPrice <= 0) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'propertyPrice must be a positive number.' }
    });
  }

  if (!Number.isFinite(numericInterestRate) || numericInterestRate <= 0 || numericInterestRate > 25) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'interestRate must be a positive number (percent) under 25.' }
    });
  }

  if (!Number.isFinite(numericRentMonthly) || numericRentMonthly <= 0) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'comparableRentMonthly must be a positive number.' }
    });
  }

  if (!Number.isFinite(numericDownPaymentPercent) || numericDownPaymentPercent < 0 || numericDownPaymentPercent >= 100) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'downPaymentPercent must be between 0 and 99.' }
    });
  }

  if (!Number.isInteger(numericTenureYears) || numericTenureYears <= 0 || numericTenureYears > 40) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'tenureYears must be a whole number between 1 and 40.' }
    });
  }

  try {
    const marketDefault = await knex('city_market_defaults').where({ city }).first();
    const stampDutyConfig = await knex('state_stamp_duty_rates').where({ state }).first();

    const expectedAppreciationPercent = marketDefault ? parseFloat(marketDefault.appreciation_rate) : 5.00;
    const expectedRentEscalationPercent = 8.00; // standard Indian rental escalation benchmark
    const stampDutyPercent = stampDutyConfig ? parseFloat(stampDutyConfig.rate_percent) : 7.00;
    const registrationPercent = stampDutyConfig ? parseFloat(stampDutyConfig.registration_fee_percent) : 1.00;

    const maintenanceMonthly = (numericPropertyPrice * 0.002) / 12;

    const calculationParams = {
      propertyPrice: numericPropertyPrice,
      downPaymentPercent: numericDownPaymentPercent,
      interestRate: numericInterestRate,
      tenureYears: numericTenureYears,
      maintenanceMonthly,
      comparableRentMonthly: numericRentMonthly,
      expectedAppreciationPercent,
      expectedRentEscalationPercent,
      taxDeductionToggle: !!taxDeductionToggle,
      stampDutyPercent,
      registrationPercent,
    };

    const calculationResult = calculateRentVsBuyMetrics(calculationParams);

    // Best-effort logging — a failed insert shouldn't block the buyer from
    // getting their result.
    try {
      await knex('rent_vs_buy_calculations').insert({
        tenant_id: tenantId,
        property_id: propertyId,
        input_params: JSON.stringify(calculationParams),
        result: JSON.stringify(calculationResult),
      });
    } catch (logError) {
      console.error('Failed to log rent-vs-buy calculation (non-fatal):', logError.message);
    }

    return res.status(200).json({
      success: true,
      data: {
        breakEvenYear: calculationResult.breakEvenYear,
        monthlyEmi: calculationResult.monthlyEmi,
        upfrontCosts: calculationResult.upfrontCosts,
        yearlyBreakdown: calculationResult.yearlyBreakdown,
        assumptions: {
          city,
          state,
          appreciationPercent: expectedAppreciationPercent,
          rentEscalationPercent: expectedRentEscalationPercent,
          stampDutyPercent,
          registrationPercent,
        },
      },
    });
  } catch (error) {
    console.error('Rent-vs-buy calculation failed:', error.message);
    return res.status(500).json({
      error: { code: 'CALCULATOR_CRASH', message: 'Failed to compute the rent vs buy comparison.' }
    });
  }
}

module.exports = { executeRentVsBuyCalculation };
