/**
 * @lmbr/config — public barrel
 *
 * Purpose:  Re-exports lumber commodity catalog, US regions / routing rules,
 *           and tax rate tables used across LMBR.ai web, mobile, and agents.
 * Inputs:   none.
 * Outputs:  LUMBER_SPECIES, STANDARD_DIMENSIONS, LUMBER_GRADES,
 *           calculateBoardFeet, US_REGIONS, STATE_SALES_TAX,
 *           CA_LUMBER_ASSESSMENT.
 * Agent/API: consumed by routing-agent, QA-agent, pricing-agent.
 * Imports:  ./commodities, ./regions, ./tax-rates.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export * from './commodities';
export * from './regions';
export * from './tax-rates';
export * from './timezones';
