-- 016_consolidation_source_map.sql
-- Adds source_line_item_ids UUID array to line_items for consolidation
-- source mapping. Follows the same UUID array pattern as
-- bid_routings.line_item_ids.

ALTER TABLE public.line_items
  ADD COLUMN IF NOT EXISTS source_line_item_ids uuid[] DEFAULT NULL;

-- GIN index for ANY() containment queries on source mapping.
CREATE INDEX IF NOT EXISTS line_items_source_ids_gin
  ON public.line_items USING gin (source_line_item_ids)
  WHERE source_line_item_ids IS NOT NULL;

COMMENT ON COLUMN public.line_items.source_line_item_ids IS
  'Populated only on consolidated rows (is_consolidated = true). '
  'Array of UUIDs pointing to the original line_item rows that '
  'were aggregated into this consolidated row. Original rows '
  'leave this NULL.';
