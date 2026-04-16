/**
 * @lmbr/lib — public barrel
 *
 * Purpose:  Re-exports shared infrastructure clients (Anthropic, Supabase,
 *           Microsoft Graph/Outlook), OCR + PDF helpers, and general utils.
 *           Everything used by both the web app and the mobile app lives
 *           here so credentials and SDK versions are centralized.
 * Inputs:   none.
 * Outputs:  getAnthropic, getSupabaseClient, getSupabaseAdmin,
 *           getOutlookClient, runOcr, extractPdfText, cn, formatCurrency,
 *           formatBoardFeet.
 * Agent/API: foundation for every agent in @lmbr/agents and every API route.
 * Imports:  ./anthropic, ./supabase, ./outlook, ./ocr, ./pdf, ./utils.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export * from './anthropic';
export * from './supabase';
export * from './outlook';
export * from './ocr';
export * from './pdf';
export * from './utils';
export * from './lumber';
export * from './attachment-analyzer';
export * from './lumber-parser';
export * from './cost-tracker';
export * from './queue';
export * from './vendor-token';
export * from './vendor-visibility';
