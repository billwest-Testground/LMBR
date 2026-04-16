/**
 * Mobile compare screen — vendor matrix on a phone.
 *
 * Purpose:  Mobile-optimized view of the vendor × line-item comparison
 *           matrix produced by `@lmbr/agents` `comparisonAgent` on the
 *           server. A buyer / trader-buyer pulls this up in the field to
 *           pick a vendor per line and see the running selected-total
 *           update live. Per the execution plan this is deliberately
 *           scoped DOWN vs. the web `ComparisonMatrix` — no virtualized
 *           column scroll, no "select all cheapest" / "minimize vendors"
 *           controls, no inline price editing. Those belong to the
 *           flagship desktop terminal.
 *
 *           Renders:
 *             - Loading / error / empty states (README §9).
 *             - `FlatList` rows — this is mobile virtualization for 50+
 *               lines (CLAUDE.md rule 4, README §12).
 *             - Each row is a horizontal `ScrollView` with a 200px fixed
 *               line-summary cell and 110px vendor cells.
 *             - Sticky footer at the bottom: selected total + vendor
 *               count + Export (stub — Prompt 07 owns persistence).
 *             - A permanent watermark under the header:
 *               "Internal only — vendor names never shown to customers."
 *               (CLAUDE.md Key Product Rule #1.)
 *
 *           Auth / session: mobile auth is handled outside this screen
 *           (see `new.tsx` — same pattern: direct `fetch` against
 *           `EXPO_PUBLIC_LMBR_API_URL`, cookies/tokens are attached by
 *           whatever wrapper ships in a later prompt). A 401/403 falls
 *           through to the error panel cleanly.
 *
 *           Types: the web and backend import `ComparisonResult` from
 *           `@lmbr/agents`, but the mobile workspace doesn't declare
 *           that package as a dependency (mobile only pulls `@lmbr/types`,
 *           `@lmbr/lib`, and `@lmbr/config` — see `package.json`). Rather
 *           than add a dep just to read a response shape, we declare a
 *           minimal local mirror of the fields we actually render below.
 *           If the wire shape ever drifts, update both sides — the
 *           backend owns the canonical schema in
 *           `packages/agents/src/comparison-agent.ts`.
 *
 * Inputs:   `bidId` query param (expo-router useLocalSearchParams),
 *           `EXPO_PUBLIC_LMBR_API_URL` env var.
 * Outputs:  <View> — FlatList matrix + sticky total bar.
 * Agent/API: GET /api/compare/[bidId] (remote).
 * Imports:  react-native, expo-router.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import * as React from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';

const API_URL =
  (process.env.EXPO_PUBLIC_LMBR_API_URL as string | undefined) ??
  'http://localhost:3000';

// -----------------------------------------------------------------------------
// Local mirror of the fields we render from @lmbr/agents ComparisonResult.
// Keep in sync with packages/agents/src/comparison-agent.ts — mobile does not
// import that package to avoid dragging its Zod/schema deps into the RN bundle
// for a read-only shape. If the wire contract changes, update both sides.
// -----------------------------------------------------------------------------

type Unit = 'PCS' | 'MBF' | 'MSF';

interface ComparisonVendor {
  vendorId: string;
  vendorName: string;
  vendorBidId: string;
  status: 'pending' | 'submitted' | 'partial' | 'declined' | 'expired';
}

interface ComparisonCell {
  vendorId: string;
  vendorBidLineItemId: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  isBestPrice: boolean;
  isWorstPrice: boolean;
  declined: boolean;
  percentAboveBest: number | null;
}

interface ComparisonRow {
  lineItemId: string;
  lineSummary: {
    species: string;
    dimension: string;
    grade: string | null;
    length: string | null;
    quantity: number;
    unit: Unit;
    buildingTag: string | null;
    phaseNumber: number | null;
  };
  cells: ComparisonCell[];
  bestUnitPrice: number | null;
  worstUnitPrice: number | null;
  spreadAmount: number | null;
  spreadPercent: number | null;
  bidCount: number;
  bestVendorId: string | null;
}

interface ComparisonResult {
  bidId: string;
  vendors: ComparisonVendor[];
  rows: ComparisonRow[];
}

interface CompareEnvelope {
  success: boolean;
  result?: ComparisonResult;
  error?: string;
}

interface SelectionEntry {
  vendorId: string;
  vendorBidLineItemId: string;
  unitPrice: number;
  totalPrice: number;
}

// -----------------------------------------------------------------------------
// Layout constants
// -----------------------------------------------------------------------------

const LINE_COL_WIDTH = 200;
const VENDOR_COL_WIDTH = 110;
const ROW_HEIGHT = 72;
const FOOTER_HEIGHT = 76;

// -----------------------------------------------------------------------------
// Formatters (module-level — not reallocated per render)
// -----------------------------------------------------------------------------

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const UNIT_FMT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

// -----------------------------------------------------------------------------
// Screen
// -----------------------------------------------------------------------------

export default function MobileCompareScreen() {
  const params = useLocalSearchParams<{ bidId?: string }>();
  const bidId = typeof params.bidId === 'string' ? params.bidId : undefined;

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ComparisonResult | null>(null);
  // Selection: lineItemId -> chosen vendor entry. Client-only state — persistence
  // lands in Prompt 07 (margin stacking + quote output).
  const [selections, setSelections] = React.useState<Record<string, SelectionEntry>>({});

  React.useEffect(() => {
    if (!bidId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_URL}/api/compare/${bidId}`);
        const body = (await res.json().catch(() => ({}))) as CompareEnvelope;
        if (!res.ok || !body.success || !body.result) {
          throw new Error(body.error ?? `Comparison load failed (${res.status})`);
        }
        if (!cancelled) setResult(body.result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Network error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [bidId]);

  const selectedCount = React.useMemo(
    () => Object.keys(selections).length,
    [selections],
  );
  const selectedTotal = React.useMemo(() => {
    let total = 0;
    for (const entry of Object.values(selections)) total += entry.totalPrice;
    return total;
  }, [selections]);
  const vendorsInvolvedCount = React.useMemo(() => {
    const set = new Set<string>();
    for (const entry of Object.values(selections)) set.add(entry.vendorId);
    return set.size;
  }, [selections]);

  function toggleCell(row: ComparisonRow, cell: ComparisonCell) {
    const { unitPrice, totalPrice, vendorBidLineItemId } = cell;
    if (
      unitPrice === null ||
      totalPrice === null ||
      vendorBidLineItemId === null ||
      cell.declined
    ) {
      return;
    }
    // Narrowed locals so the setState closure below doesn't re-widen.
    const entry: SelectionEntry = {
      vendorId: cell.vendorId,
      vendorBidLineItemId,
      unitPrice,
      totalPrice,
    };
    setSelections((prev) => {
      const existing = prev[row.lineItemId];
      const next = { ...prev };
      if (existing && existing.vendorId === cell.vendorId) {
        // Tapping the already-selected cell clears the selection for that line.
        delete next[row.lineItemId];
      } else {
        next[row.lineItemId] = entry;
      }
      return next;
    });
  }

  function handleExport() {
    // TODO(prompt-07): hand this selection off to the margin stacking /
    // quote generation flow. For now surface a confirmation alert so the
    // trader sees their count.
    Alert.alert(
      'Export ready',
      `${selectedCount} line(s) selected across ${vendorsInvolvedCount} vendor(s). Margin stacking lands in Prompt 07.`,
    );
  }

  // ---- render ----------------------------------------------------------------

  if (!bidId) {
    return (
      <View className="flex-1 bg-bg-base" style={{ paddingTop: 40 }}>
        <Header title="Comparison" subtitle="No bid selected" />
        <ErrorPanel message="Missing bidId parameter. Open a bid before tapping Compare." />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-bg-base" style={{ paddingTop: 40 }}>
      <Header title="Comparison" subtitle={`Bid ${bidId.slice(0, 8)}`} />
      <Text className="px-5 text-caption text-text-tertiary">
        Internal only — vendor names never shown to customers.
      </Text>

      {loading && (
        <View className="flex-1 items-center justify-center">
          <View className="flex-row items-center gap-3 rounded-md border border-border-base bg-bg-surface px-4 py-3">
            <ActivityIndicator size="small" />
            <Text className="text-body-sm text-text-secondary">Loading comparison…</Text>
          </View>
        </View>
      )}

      {!loading && error && <ErrorPanel message={error} />}

      {!loading && !error && result && result.rows.length === 0 && (
        <EmptyState
          title="Awaiting vendor responses"
          description="No vendor prices have landed yet. Once vendors submit, their pricing will appear here."
        />
      )}

      {!loading && !error && result && result.rows.length > 0 && (
        <>
          <Matrix result={result} selections={selections} onToggle={toggleCell} />
          <TotalBar
            total={selectedTotal}
            selectedCount={selectedCount}
            vendorCount={vendorsInvolvedCount}
            onExport={handleExport}
          />
        </>
      )}
    </View>
  );
}

// -----------------------------------------------------------------------------
// Matrix (FlatList of rows, each row is a horizontal ScrollView)
// -----------------------------------------------------------------------------

interface MatrixProps {
  result: ComparisonResult;
  selections: Record<string, SelectionEntry>;
  onToggle: (row: ComparisonRow, cell: ComparisonCell) => void;
}

function Matrix({ result, selections, onToggle }: MatrixProps) {
  // Sticky column-header row across the top of the matrix viewport. Wraps the
  // vendor names in the same horizontal ScrollView so the header scrolls in
  // lockstep with the body cells.
  const renderItem = React.useCallback(
    ({ item }: { item: ComparisonRow }) => (
      <MatrixRow
        row={item}
        vendors={result.vendors}
        selectedVendorId={selections[item.lineItemId]?.vendorId ?? null}
        onToggle={onToggle}
      />
    ),
    [result.vendors, selections, onToggle],
  );

  return (
    <View className="flex-1" style={{ paddingBottom: FOOTER_HEIGHT }}>
      <FlatList
        data={result.rows}
        keyExtractor={(row) => row.lineItemId}
        renderItem={renderItem}
        getItemLayout={(_data, index) => ({
          length: ROW_HEIGHT,
          offset: ROW_HEIGHT * index,
          index,
        })}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        ListHeaderComponent={<MatrixHeader vendors={result.vendors} />}
        stickyHeaderIndices={[0]}
      />
    </View>
  );
}

interface MatrixHeaderProps {
  vendors: ComparisonVendor[];
}

function MatrixHeader({ vendors }: MatrixHeaderProps) {
  return (
    <View className="border-b border-border-base bg-bg-surface">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ flexDirection: 'row' }}
      >
        <View
          style={{ width: LINE_COL_WIDTH }}
          className="justify-center border-r border-border-base px-3 py-2"
        >
          <Text className="text-label uppercase text-text-tertiary">Line</Text>
        </View>
        {vendors.map((vendor) => (
          <View
            key={vendor.vendorId}
            style={{ width: VENDOR_COL_WIDTH }}
            className="items-end justify-center border-r border-border-base px-2 py-2"
          >
            <Text
              className="text-label uppercase text-text-tertiary"
              numberOfLines={1}
            >
              {vendor.vendorName}
            </Text>
            <Text className="text-[10px] text-text-tertiary">
              {formatStatus(vendor.status)}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

interface MatrixRowProps {
  row: ComparisonRow;
  vendors: ComparisonVendor[];
  selectedVendorId: string | null;
  onToggle: (row: ComparisonRow, cell: ComparisonCell) => void;
}

const MatrixRow = React.memo(function MatrixRow({
  row,
  vendors,
  selectedVendorId,
  onToggle,
}: MatrixRowProps) {
  const { species, dimension, grade, length, quantity, unit, buildingTag } =
    row.lineSummary;

  // Index cells by vendorId so a column layout inside the row matches the
  // vendor header order even if the upstream cells list is reordered.
  const cellByVendor = React.useMemo(() => {
    const map = new Map<string, ComparisonCell>();
    for (const c of row.cells) map.set(c.vendorId, c);
    return map;
  }, [row.cells]);

  return (
    <View
      style={{ height: ROW_HEIGHT }}
      className="border-b border-border-base"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ flexDirection: 'row' }}
      >
        <View
          style={{ width: LINE_COL_WIDTH }}
          className="justify-center border-r border-border-base bg-bg-surface px-3 py-2"
        >
          <Text
            className="text-body-sm font-semibold text-text-primary"
            numberOfLines={1}
          >
            {species} {dimension}
          </Text>
          <Text className="text-caption text-text-tertiary" numberOfLines={1}>
            {[grade, length, `${quantity} ${unit}`].filter(Boolean).join(' · ')}
          </Text>
          {buildingTag ? (
            <Text className="text-[10px] text-text-tertiary" numberOfLines={1}>
              {buildingTag}
            </Text>
          ) : null}
        </View>

        {vendors.map((vendor) => {
          const cell = cellByVendor.get(vendor.vendorId);
          const isSelected = selectedVendorId === vendor.vendorId;
          return (
            <MatrixCell
              key={vendor.vendorId}
              cell={cell}
              isSelected={isSelected}
              onPress={() => {
                if (cell) onToggle(row, cell);
              }}
            />
          );
        })}
      </ScrollView>
    </View>
  );
});

interface MatrixCellProps {
  cell: ComparisonCell | undefined;
  isSelected: boolean;
  onPress: () => void;
}

function MatrixCell({ cell, isSelected, onPress }: MatrixCellProps) {
  // Missing cell = vendor exists as a column but no row was produced by the
  // agent for this line (should not happen — agent emits a null-priced cell
  // for every vendor — but we stay defensive).
  if (!cell) {
    return (
      <View
        style={{ width: VENDOR_COL_WIDTH }}
        className="items-end justify-center border-r border-border-base px-2 py-2"
      >
        <Text className="text-body-sm text-text-tertiary">—</Text>
      </View>
    );
  }

  const priced = cell.unitPrice !== null && !cell.declined;
  const selectedClasses = isSelected
    ? 'bg-accent-warm/12 border border-accent-warm/40'
    : '';

  return (
    <Pressable
      onPress={priced ? onPress : undefined}
      disabled={!priced}
      style={{ width: VENDOR_COL_WIDTH }}
      className={`items-end justify-center border-r border-border-base px-2 py-2 ${selectedClasses}`}
      accessibilityRole="button"
      accessibilityLabel={
        priced
          ? `Select vendor price ${cell.unitPrice}`
          : cell.declined
            ? 'Vendor declined this line'
            : 'No bid for this line'
      }
    >
      {cell.declined ? (
        <Text className="text-body-sm italic text-text-tertiary">declined</Text>
      ) : cell.unitPrice === null ? (
        <Text className="text-body-sm text-text-tertiary">—</Text>
      ) : (
        <>
          <Text
            style={{ fontVariant: ['tabular-nums'] }}
            className="text-body-sm font-mono text-text-primary"
          >
            {UNIT_FMT.format(cell.unitPrice)}
          </Text>
          {cell.isBestPrice ? (
            <View className="mt-0.5 rounded-sm bg-accent-primary/15 px-1 py-[1px]">
              <Text className="text-[9px] font-semibold uppercase text-accent-primary">
                Best
              </Text>
            </View>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

// -----------------------------------------------------------------------------
// Sticky total bar
// -----------------------------------------------------------------------------

interface TotalBarProps {
  total: number;
  selectedCount: number;
  vendorCount: number;
  onExport: () => void;
}

function TotalBar({ total, selectedCount, vendorCount, onExport }: TotalBarProps) {
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: FOOTER_HEIGHT,
      }}
      className="flex-row items-center justify-between border-t border-border-strong bg-bg-surface px-4"
    >
      <View>
        <Text className="text-label uppercase text-text-tertiary">Selected total</Text>
        <Text
          style={{ fontVariant: ['tabular-nums'] }}
          className="text-h3 font-mono text-text-primary"
        >
          {USD.format(total)}
        </Text>
      </View>
      <View className="flex-row items-center gap-3">
        <View className="rounded-sm border border-border-base bg-bg-elevated px-2 py-1">
          <Text className="text-caption text-text-secondary">
            {selectedCount} line{selectedCount === 1 ? '' : 's'} · {vendorCount} vendor
            {vendorCount === 1 ? '' : 's'}
          </Text>
        </View>
        <Pressable
          onPress={onExport}
          disabled={selectedCount === 0}
          className="rounded-sm bg-accent-primary px-4 py-2 active:bg-accent-secondary"
          accessibilityRole="button"
          accessibilityLabel="Export selection"
        >
          <Text className="text-body font-semibold text-text-inverse">Export</Text>
        </Pressable>
      </View>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Shared panels
// -----------------------------------------------------------------------------

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View className="px-5 pb-2 pt-4">
      <Text className="text-label uppercase text-text-tertiary">{subtitle}</Text>
      <Text className="mt-1 text-h1 text-text-primary">{title}</Text>
    </View>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <View className="mx-5 mt-4 rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2">
      <Text className="text-body-sm text-semantic-error">{message}</Text>
    </View>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <View className="mx-5 mt-6 rounded-md border border-border-base bg-bg-surface p-5">
      <Text className="text-h4 text-text-primary">{title}</Text>
      <Text className="mt-1 text-body-sm text-text-secondary">{description}</Text>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatStatus(status: ComparisonVendor['status']): string {
  switch (status) {
    case 'submitted':
      return 'submitted';
    case 'partial':
      return 'partial';
    case 'declined':
      return 'declined';
    case 'expired':
      return 'expired';
    case 'pending':
    default:
      return 'pending';
  }
}
