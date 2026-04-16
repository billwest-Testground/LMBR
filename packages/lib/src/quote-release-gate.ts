/**
 * Purpose:  Pure, deterministic guard that decides whether a quote in a
 *           given persisted status is eligible for the release path
 *           (PDF render + upload + status flip to 'approved').
 *
 *           Extracted from /api/quote so the decision can be unit
 *           tested without a Next.js request shim. The route handler
 *           calls this AFTER it re-reads the latest quotes row and
 *           BEFORE it spends any time on render / upload.
 *
 *           Semantics (aligns with migration 008 RLS + the approval
 *           gate enforced in applyMargin):
 *             - 'pending_approval' → manager releases, becomes 'approved'.
 *             - 'approved'         → already released; idempotent re-render
 *                                    is allowed (manager tweak + re-issue).
 *             - 'draft'            → reject with `cannot_release_draft`.
 *             - 'sent'             → reject with `already_sent`; editing a
 *                                    sent quote is a Prompt 08 concern
 *                                    (Outlook send-state is the source of
 *                                    truth once an email goes out).
 *             - 'accepted' |
 *               'declined'        → reject with `quote_finalized`; the
 *                                    customer response is terminal.
 *
 *           Returning a discriminated union keeps the route handler's
 *           HTTP mapping explicit and type-checked — no stringly-typed
 *           error bag.
 *
 * Inputs:   QuoteStatus (one of the enum values from migration 008).
 * Outputs:  QuoteReleaseGateResult — `{ ok: true }` or
 *           `{ ok: false, error, message }`.
 * Agent/API: none — pure TypeScript.
 * Imports:  none.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export type QuoteStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'sent'
  | 'accepted'
  | 'declined';

export type QuoteReleaseGateError =
  | 'cannot_release_draft'
  | 'already_sent'
  | 'quote_finalized';

export type QuoteReleaseGateResult =
  | { ok: true }
  | { ok: false; error: QuoteReleaseGateError; message: string };

/**
 * Decide whether a quote in `status` may be released. Pure. No I/O.
 *
 * The boundary rules here intentionally mirror migration 008's RLS
 * policy — that policy is the backstop, this function is the primary
 * defense so we can return clean 409s instead of surfacing a DB error
 * to the UI.
 */
export function canReleaseQuote(status: QuoteStatus): QuoteReleaseGateResult {
  switch (status) {
    case 'pending_approval':
    case 'approved':
      // 'pending_approval': manager clears the gate.
      // 'approved': idempotent re-release is allowed so a manager can
      //             re-render after a margin tweak without having to
      //             recycle the row through pending_approval.
      return { ok: true };
    case 'draft':
      return {
        ok: false,
        error: 'cannot_release_draft',
        message: 'Quote is a draft — submit for approval first',
      };
    case 'sent':
      return {
        ok: false,
        error: 'already_sent',
        message: 'Quote has already been sent — editing a sent quote is not supported',
      };
    case 'accepted':
    case 'declined':
      return {
        ok: false,
        error: 'quote_finalized',
        message: `Quote is ${status} — cannot be re-released`,
      };
    default: {
      // Exhaustive: if the quote_status enum grows a new value, this
      // line will fail to compile until the caller wires it in.
      const _exhaustive: never = status;
      void _exhaustive;
      return {
        ok: false,
        error: 'quote_finalized',
        message: 'Unknown quote status',
      };
    }
  }
}
