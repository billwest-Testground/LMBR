/**
 * LineItemTable — editable line items grid.
 *
 * Purpose:  Dense table view of a bid's line items. Shows species, grade,
 *           dimensions, house, phase, quantity, board feet, cost, sell.
 *           QA issues render inline.
 * Inputs:   { lineItems: LineItem[], issues?: QaIssue[] }.
 * Outputs:  JSX.
 * Agent/API: qa-agent issues only (display).
 * Imports:  @lmbr/types (LineItem).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { LineItem } from '@lmbr/types';

export function LineItemTable(_props: { lineItems: LineItem[] }) {
  return <div>Not implemented: LineItemTable</div>;
}
