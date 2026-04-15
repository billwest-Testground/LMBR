/**
 * QA agent — validates extracted line items against the commodity catalog.
 *
 * Purpose:  Guards the LMBR.ai pipeline against garbage-in. Takes a raw
 *           set of line items from the ingest/extraction step, validates
 *           species/grade/dimension combinations against @lmbr/config, and
 *           flags anything ambiguous for human review before the bid is
 *           routed to a Buyer. Surfaces structured warnings the UI renders
 *           inline on the line-item-table.
 * Inputs:   { companyId, lineItems[] }.
 * Outputs:  { ok, normalizedLineItems[], issues[] }.
 * Agent/API: Anthropic Claude (rule-based fallback + LLM disambiguation).
 * Imports:  @lmbr/types, @lmbr/config, zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { LineItem } from '@lmbr/types';

export interface QaIssue {
  lineItemId: string;
  field: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestion?: string;
}

export interface QaResult {
  ok: boolean;
  normalizedLineItems: LineItem[];
  issues: QaIssue[];
}

export async function qaAgent(
  _input: { companyId: string; lineItems: LineItem[] },
): Promise<QaResult> {
  throw new Error('Not implemented');
}
