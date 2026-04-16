/**
 * Vendor-visible line-item filter — which rows a vendor should see/price.
 *
 * Purpose:  A bid's consolidation_mode determines what the mill/vendor sees
 *           on the submission form / printable PDF / scan-back sheet.
 *
 *             • 'consolidated' | 'hybrid' → vendor prices the aggregated
 *               tally (rows where is_consolidated = true). In hybrid mode
 *               the customer-facing quote is later rebuilt from the
 *               original per-building rows via original_line_item_id.
 *             • 'structured'   | 'phased' → vendor prices the rows exactly
 *               as they came in (is_consolidated = false).
 *
 *           Centralizing the rule here avoids three copies of the same
 *           ternary in the submission page (Task 3), the printable PDF
 *           (Task 4), and the scan-back OCR attribution (Task 5). All
 *           three must return the same set or the matrix breaks.
 *
 * Inputs:   ConsolidationMode from @lmbr/types.
 * Outputs:  vendorVisibleIsConsolidatedFlag(mode): boolean.
 * Agent/API: used by the vendor submission page, submission API, PDF
 *            tally generator, and scan-back price matcher.
 * Imports:  @lmbr/types (ConsolidationMode).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { ConsolidationMode } from '@lmbr/types';

/**
 * Return the `is_consolidated` column value that selects the rows a vendor
 * should price for a bid with the given consolidation mode.
 *
 * Usage pattern:
 * ```ts
 *   const flag = vendorVisibleIsConsolidatedFlag(bid.consolidation_mode);
 *   const { data } = await admin
 *     .from('line_items')
 *     .select('id, ...')
 *     .eq('bid_id', bidId)
 *     .eq('is_consolidated', flag)
 *     .order('sort_order', { ascending: true });
 * ```
 *
 * Rule:
 *   - 'consolidated' | 'hybrid' → true  (vendor sees the aggregated tally)
 *   - 'structured'   | 'phased' → false (vendor sees originals as-received)
 *
 * The switch is exhaustive over `ConsolidationMode` so adding a new mode
 * to the enum will surface as a TypeScript error at compile time — that's
 * intentional; "vendor visibility" is a first-class concern that a new
 * mode must explicitly decide.
 */
export function vendorVisibleIsConsolidatedFlag(mode: ConsolidationMode): boolean {
  switch (mode) {
    case 'consolidated':
    case 'hybrid':
      return true;
    case 'structured':
    case 'phased':
      return false;
    default: {
      // Exhaustiveness check: if a new ConsolidationMode is added upstream,
      // this line will fail to compile until the switch is extended.
      const _never: never = mode;
      throw new Error(
        `LMBR.ai: vendorVisibleIsConsolidatedFlag received unknown ConsolidationMode '${_never as string}'.`,
      );
    }
  }
}
