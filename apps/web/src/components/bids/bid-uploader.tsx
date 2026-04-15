/**
 * BidUploader — drag-and-drop ingest surface.
 *
 * Purpose:  Accepts PDFs, Excels, email bodies, or images and POSTs them
 *           to /api/ingest. Shows progress and agent feedback.
 * Inputs:   drag/drop or file picker.
 * Outputs:  JSX + callback onIngested(bidId).
 * Agent/API: /api/ingest → ingest-agent.
 * Imports:  @lmbr/types (BidSource).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export function BidUploader(_props: { onIngested?: (bidId: string) => void }) {
  return <div>Not implemented: BidUploader</div>;
}
