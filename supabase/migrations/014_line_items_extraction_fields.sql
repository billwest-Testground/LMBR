-- =============================================================================
-- LMBR.ai migration 014 — line_items extraction fields
-- Built by Worklighter.
--
-- Adds explicit per-line provenance for the tiered ingest engine (Session
-- Prompt 04). Before this migration the extraction confidence, flag list,
-- and original source text were packed into the notes column as an opaque
-- JSON blob. The tiered engine needs first-class columns because:
--
--   1. Cost accounting — every line records the $ amount actually spent
--      getting it into the system (0 cents for Excel/CSV/clean-PDF parse,
--      ~0.15 cents for OCR, ~1.5 cents for a Claude Mode A row). The
--      manager dashboard rolls these up per bid and per company.
--
--   2. Method-aware review — the line_item_table UI shows a subtle
--      extraction_method badge so traders can zero in on claude_extraction
--      rows that merit an extra look.
--
--   3. Threshold tuning — extraction_confidence is the dial the
--      orchestrator uses to decide whether a line needs Mode B cleanup.
--      The env var EXTRACTION_CONFIDENCE_THRESHOLD (default 0.92) is the
--      cutoff; once we have a few hundred real bids through the pipeline
--      the cost_cents + confidence distribution will tell us whether 0.92
--      is too aggressive or too conservative for the real mix of files.
--
-- Backwards compatibility: the notes column is intentionally left in place.
-- The existing review UI still reads {confidence, flags, original_text}
-- from notes, and the orchestrator continues to write both until the new
-- columns are proven in production. A follow-up migration will clean up
-- the JSON blob once the UI has been cut over.
-- =============================================================================

alter table public.line_items
  add column if not exists extraction_method     text,
  add column if not exists extraction_confidence numeric(4,3),
  add column if not exists cost_cents            numeric(8,4) not null default 0;

-- Valid methods are enforced at the application layer (TypeScript union)
-- rather than with a CHECK constraint so that adding new methods does not
-- require a schema migration. The index below keeps the manager dashboard
-- "extraction cost by method" query fast even as volume grows.
create index if not exists line_items_extraction_method_idx
  on public.line_items(extraction_method);

-- Index supports "show me all low-confidence lines on this bid" queries
-- from the review UI without a full scan of line_items.
create index if not exists line_items_bid_confidence_idx
  on public.line_items(bid_id, extraction_confidence);
