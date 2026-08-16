/**
 * Runs a year-by-year comparison between buying (EMI + maintenance + stamp
 * duty, offset by tax deductions and property appreciation) and renting
 * (rent + escalation, offset by investing the difference at a conservative
 * assumed yield). Returns the year the cumulative cost of buying first
 * drops below the cumulative cost of renting, plus the full year-by-year
 * series so the frontend can chart it.
 *
 * All inputs are assumed pre-validated (positive numbers, sane ranges) by
 * the controller — this function does not re-validate.
 */
function calculateRentVsBuyMetrics(params) {
  const {
    propertyPrice,
    downPaymentPercent,
    interestRate,
    tenureYears,
    maintenanceMonthly,
    comparableRentMonthly,
    expectedAppreciationPercent,
    expectedRentEscalationPercent,
    taxDeductionToggle,
    stampDutyPercent,
    registrationPercent,
  } = params;

  const loanToValuePercent = 100 - downPaymentPercent;
  const loanPrincipal = propertyPrice * (loanToValuePercent / 100);
  const monthlyRate = (interestRate / 100) / 12;
  const totalMonths = tenureYears * 12;

  // Standard fixed EMI. monthlyRate === 0 only happens with a 0% interest
  // rate input, which validation should already reject, but guarded anyway.
  const emi = monthlyRate === 0
    ? loanPrincipal / totalMonths
    : (loanPrincipal * monthlyRate * Math.pow(1 + monthlyRate, totalMonths))
      / (Math.pow(1 + monthlyRate, totalMonths) - 1);
  const annualEmiTotal = emi * 12;

  // Upfront capital outlay for buying
  const stampDutyCost = propertyPrice * (stampDutyPercent / 100);
  const registrationCost = propertyPrice * (registrationPercent / 100);
  const initialDownPayment = propertyPrice * (downPaymentPercent / 100);
  const totalUpfrontBuyingCost = initialDownPayment + stampDutyCost + registrationCost;

  // Opportunity-cost baseline: the renter invests what buying would have
  // required upfront, plus whatever they save in any year buying costs more
  // than renting, at a conservative assumed yield.
  const investmentOpportunityRate = 0.07;
  let cumulativeRentingOpportunityWealth = totalUpfrontBuyingCost;

  let currentPropertyValue = propertyPrice;
  let currentRemainingBalance = loanPrincipal;
  let currentRentMonthly = comparableRentMonthly;
  let currentMaintenanceMonthly = maintenanceMonthly;

  let cumulativeCostBuy = totalUpfrontBuyingCost;
  let cumulativeCostRent = 0;
  let breakEvenYear = null;
  const yearlyBreakdown = [];

  for (let year = 1; year <= tenureYears; year++) {
    let principalPaidThisYear = 0;
    let interestPaidThisYear = 0;

    for (let m = 0; m < 12; m++) {
      if (currentRemainingBalance > 0) {
        const interestMonth = currentRemainingBalance * monthlyRate;
        const principalMonth = Math.min(emi - interestMonth, currentRemainingBalance);
        interestPaidThisYear += interestMonth;
        principalPaidThisYear += principalMonth;
        currentRemainingBalance -= principalMonth;
      }
    }

    // India tax benefits: Section 24 (interest, capped 2L) + Section 80C
    // (principal, capped 1.5L), assumed at a 30% bracket.
    let taxSavings = 0;
    if (taxDeductionToggle) {
      const section24Savings = Math.min(interestPaidThisYear, 200000) * 0.30;
      const section80CSavings = Math.min(principalPaidThisYear, 150000) * 0.30;
      taxSavings = section24Savings + section80CSavings;
    }

    currentPropertyValue *= (1 + (expectedAppreciationPercent / 100));
    const annualMaintenance = currentMaintenanceMonthly * 12;

    const netYearlyBuyOutflow = annualEmiTotal + annualMaintenance - taxSavings;
    cumulativeCostBuy += netYearlyBuyOutflow;

    const annualRentPaid = currentRentMonthly * 12;
    cumulativeCostRent += annualRentPaid;

    const netRentSavedVsBuy = netYearlyBuyOutflow - annualRentPaid;
    if (netRentSavedVsBuy > 0) {
      cumulativeRentingOpportunityWealth = (cumulativeRentingOpportunityWealth + netRentSavedVsBuy) * (1 + investmentOpportunityRate);
    } else {
      cumulativeRentingOpportunityWealth = cumulativeRentingOpportunityWealth * (1 + investmentOpportunityRate) + netRentSavedVsBuy;
    }

    const buyersEquity = currentPropertyValue - currentRemainingBalance;
    const netCostBuyingResult = cumulativeCostBuy - buyersEquity;

    // BUG FIXED (original draft): this subtracted the wrong way, ADDING the
    // renter's invested-savings growth to their "cost" instead of
    // subtracting it. That made renting look artificially worse every year
    // regardless of the actual numbers — the calculator would tell a buyer
    // "buying wins from year 1" even when comparing a ₹50L property against
    // ₹5,000/month rent. The renter's accumulated investment wealth is an
    // asset (mirrors buyersEquity above), so it must reduce their net cost,
    // not inflate it.
    const rentingInvestmentGain = cumulativeRentingOpportunityWealth - totalUpfrontBuyingCost;
    const netCostRentingResult = cumulativeCostRent - rentingInvestmentGain;

    yearlyBreakdown.push({
      year,
      propertyValue: Math.round(currentPropertyValue),
      remainingLoanBalance: Math.round(Math.max(currentRemainingBalance, 0)),
      cumulativeRentPaid: Math.round(cumulativeCostRent),
      netCostBuying: Math.round(netCostBuyingResult),
      netCostRenting: Math.round(netCostRentingResult),
    });

    if (breakEvenYear === null && netCostBuyingResult < netCostRentingResult) {
      breakEvenYear = year;
    }

    currentRentMonthly *= (1 + (expectedRentEscalationPercent / 100));
    currentMaintenanceMonthly *= 1.05;
  }

  return {
    breakEvenYear: breakEvenYear || 'Beyond the selected tenure',
    upfrontCosts: {
      downPayment: Math.round(initialDownPayment),
      stampDuty: Math.round(stampDutyCost),
      registration: Math.round(registrationCost),
      total: Math.round(totalUpfrontBuyingCost),
    },
    monthlyEmi: Math.round(emi),
    yearlyBreakdown,
  };
}

module.exports = { calculateRentVsBuyMetrics };
