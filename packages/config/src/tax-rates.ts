/**
 * Tax rate tables — state sales tax and CA lumber assessment.
 *
 * Purpose:  Reference tax data for the LMBR.ai quote generator. The CA
 *           Lumber Products Assessment is a 1% state-imposed fee on
 *           qualifying lumber sold for end use in California. State sales
 *           tax is a coarse base rate — actual rate resolution (county /
 *           special district) happens downstream in the quote API.
 * Inputs:   state code.
 * Outputs:  STATE_SALES_TAX map, CA_LUMBER_ASSESSMENT constant,
 *           getStateSalesTax (stub).
 * Agent/API: consumed by /api/quote and /api/budget-quote routes.
 * Imports:  none.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

/**
 * California Lumber Products Assessment — 1% on qualifying lumber sales
 * destined for consumption in California. Stub value, verify annually.
 */
export const CA_LUMBER_ASSESSMENT = 0.01;

/**
 * Base state sales tax rates (stub — coarse state-level only).
 * Values are placeholders for scaffolding; replace with an authoritative
 * source (e.g. Avalara, TaxJar) before production release.
 */
export const STATE_SALES_TAX: Readonly<Record<string, number>> = Object.freeze({
  AL: 0.04, AK: 0.0, AZ: 0.056, AR: 0.065, CA: 0.0725,
  CO: 0.029, CT: 0.0635, DE: 0.0, FL: 0.06, GA: 0.04,
  HI: 0.04, ID: 0.06, IL: 0.0625, IN: 0.07, IA: 0.06,
  KS: 0.065, KY: 0.06, LA: 0.0445, ME: 0.055, MD: 0.06,
  MA: 0.0625, MI: 0.06, MN: 0.06875, MS: 0.07, MO: 0.04225,
  MT: 0.0, NE: 0.055, NV: 0.0685, NH: 0.0, NJ: 0.06625,
  NM: 0.04875, NY: 0.04, NC: 0.0475, ND: 0.05, OH: 0.0575,
  OK: 0.045, OR: 0.0, PA: 0.06, RI: 0.07, SC: 0.06,
  SD: 0.042, TN: 0.07, TX: 0.0625, UT: 0.0485, VT: 0.06,
  VA: 0.053, WA: 0.065, WV: 0.06, WI: 0.05, WY: 0.04,
  DC: 0.06,
});

/**
 * Resolve the base state sales tax for a 2-letter state code.
 * Implementation stub — production path will layer in county / special
 * district rates from an address-aware tax service.
 */
export function getStateSalesTax(_stateCode: string): number {
  throw new Error('Not implemented');
}

/**
 * Resolve the CA lumber assessment for a given line item total.
 * Implementation stub — exemption rules pending.
 */
export function getCaLumberAssessment(_lineSubtotal: number): number {
  throw new Error('Not implemented');
}
