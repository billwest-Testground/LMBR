/**
 * Mobile dashboard tab — field-ready overview w/ manager approval queue.
 *
 * Purpose:  Primary landing screen for all roles in the mobile app. The
 *           hero feature is a **manager/owner-only pending-approvals
 *           queue** — if the caller has approval permissions and any
 *           quotes are sitting in `status = pending_approval`, they show
 *           up here as a tappable list. Tapping a row opens an inline
 *           action panel with Approve / Request changes / Reject, each
 *           of which POSTs back to /api/manager/approvals and refetches.
 *
 *           Below approvals we show a "Quick actions" strip so the screen
 *           remains useful for non-managers (trader / buyer / trader-buyer)
 *           — "Scan new bid" and "Open bids" tabs are always available.
 *
 *           Mobile auth today is unauthenticated (same precedent as
 *           bids/new.tsx and bids/compare.tsx — cookies/tokens arrive in
 *           Prompt 11). If the GET returns 401, we fall through to a
 *           "Log in on desktop first" empty panel. If the GET returns
 *           403 the caller isn't a manager/owner — we hide the card
 *           entirely and just show quick actions + header, matching the
 *           web dashboard's role gating.
 *
 *           Push notifications for new approvals: expo-notifications is
 *           already a declared dependency (see package.json) but the
 *           permission-grant + device-token registration flow lands in
 *           Prompt 11 (settings) alongside mobile auth. When that ships,
 *           wire a subscription here to refetch the list on inbound
 *           notifications instead of relying solely on pull-to-refresh.
 *
 * Inputs:   EXPO_PUBLIC_LMBR_API_URL; no session yet.
 * Outputs:  <View>.
 * Agent/API: GET + POST /api/manager/approvals.
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
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';

const API_URL =
  (process.env.EXPO_PUBLIC_LMBR_API_URL as string | undefined) ??
  'http://localhost:3000';

// -----------------------------------------------------------------------------
// Wire types — mirror /api/manager/approvals GET response. Keep in sync with
// apps/web/src/app/api/manager/approvals/route.ts. Mobile does not import the
// web package, so we restate the shape here.
// -----------------------------------------------------------------------------

interface ApprovalItem {
  quoteId: string;
  bidId: string;
  customer: string;
  jobName: string | null;
  trader: string;
  total: number;
  blendedMarginPercent: number;
  submittedAt: string;
}

interface ApprovalListResponse {
  items: ApprovalItem[];
}

type ApprovalAction = 'approve' | 'request_changes' | 'reject';

// Inline cap — if > INLINE_CAP rows, we show the first INLINE_CAP and
// surface a "N more pending" hint. A dedicated all-approvals screen is
// deferred (note in the card render).
const INLINE_CAP = 5;

// -----------------------------------------------------------------------------
// Formatters
// -----------------------------------------------------------------------------

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const DATE_LONG = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

// -----------------------------------------------------------------------------
// Screen
// -----------------------------------------------------------------------------

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; items: ApprovalItem[] }
  | { kind: 'hidden' } // 403 — not a manager/owner
  | { kind: 'unauthenticated' } // 401 — desktop login required
  | { kind: 'error'; message: string };

export default function DashboardScreen() {
  const router = useRouter();
  const [state, setState] = React.useState<LoadState>({ kind: 'idle' });
  const [refreshing, setRefreshing] = React.useState(false);
  const [expandedQuoteId, setExpandedQuoteId] = React.useState<string | null>(
    null,
  );
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);

  const loadApprovals = React.useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'initial') setState({ kind: 'loading' });
      if (mode === 'refresh') setRefreshing(true);
      try {
        const res = await fetch(`${API_URL}/api/manager/approvals`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (res.status === 401) {
          setState({ kind: 'unauthenticated' });
          return;
        }
        if (res.status === 403) {
          // Caller isn't a manager/owner — hide the card entirely.
          setState({ kind: 'hidden' });
          return;
        }
        const body = (await res.json().catch(() => ({}))) as
          | ApprovalListResponse
          | { error?: string };
        if (!res.ok) {
          const msg =
            (body as { error?: string }).error ??
            `Approval list failed (${res.status})`;
          setState({ kind: 'error', message: msg });
          return;
        }
        const items = (body as ApprovalListResponse).items ?? [];
        setState({ kind: 'ready', items });
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        });
      } finally {
        if (mode === 'refresh') setRefreshing(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    loadApprovals('initial');
  }, [loadApprovals]);

  async function postVerdict(
    quoteId: string,
    action: ApprovalAction,
    notes?: string,
  ): Promise<void> {
    setPendingAction(quoteId + ':' + action);
    try {
      const res = await fetch(`${API_URL}/api/manager/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(
          notes ? { quoteId, action, notes } : { quoteId, action },
        ),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Verdict failed (${res.status})`);
      }
      setExpandedQuoteId(null);
      await loadApprovals('refresh');
    } catch (err) {
      Alert.alert(
        'Verdict failed',
        err instanceof Error ? err.message : 'Network error',
      );
    } finally {
      setPendingAction(null);
    }
  }

  function handleApprove(item: ApprovalItem) {
    Alert.alert(
      'Approve quote?',
      `${item.customer} · ${USD.format(item.total)}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          onPress: () => {
            void postVerdict(item.quoteId, 'approve');
          },
        },
      ],
    );
  }

  function handleRequestChanges(item: ApprovalItem) {
    // NOTE: Alert.prompt is iOS-only. On Android, we fall back to a plain
    // confirm — POST request_changes without a note, which the backend
    // allows (notes is optional). The web approval page owns the rich
    // notes-textbox flow; mobile keeps it lean for now.
    const AlertPromptCapable = (
      Alert as unknown as {
        prompt?: (
          title: string,
          message?: string,
          callbackOrButtons?:
            | ((text: string) => void)
            | Array<{
                text: string;
                style?: 'default' | 'cancel' | 'destructive';
                onPress?: (text?: string) => void;
              }>,
          type?: 'default' | 'plain-text' | 'secure-text' | 'login-password',
          defaultValue?: string,
        ) => void;
      }
    ).prompt;

    if (typeof AlertPromptCapable === 'function') {
      AlertPromptCapable(
        'Request changes',
        `Send back to ${item.trader}. Optionally add a short note.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Send back',
            onPress: (text?: string) => {
              const trimmed = text?.trim();
              void postVerdict(
                item.quoteId,
                'request_changes',
                trimmed ? trimmed : undefined,
              );
            },
          },
        ],
        'plain-text',
      );
      return;
    }

    Alert.alert(
      'Request changes?',
      `This sends the quote back to ${item.trader} for edits.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send back',
          onPress: () => {
            void postVerdict(item.quoteId, 'request_changes');
          },
        },
      ],
    );
  }

  function handleReject(item: ApprovalItem) {
    Alert.alert(
      'Reject quote?',
      `${item.customer} · ${USD.format(item.total)}. This cannot be undone easily.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: () => {
            void postVerdict(item.quoteId, 'reject');
          },
        },
      ],
    );
  }

  // ---- render --------------------------------------------------------------

  const subtitle = DATE_LONG.format(new Date());
  const showApprovalCard = state.kind === 'ready' || state.kind === 'loading';

  return (
    <ScrollView
      className="flex-1 bg-bg-base"
      contentContainerStyle={{ paddingTop: 40, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            void loadApprovals('refresh');
          }}
          tintColor="#94A1A0"
        />
      }
    >
      <View className="px-5">
        <Text className="text-label uppercase text-text-tertiary">
          {subtitle}
        </Text>
        <Text className="mt-1 text-h1 text-text-primary">Dashboard</Text>
      </View>

      {/* ---- Approvals card ------------------------------------------------- */}
      {showApprovalCard && (
        <View className="mt-6 px-5">
          <ApprovalCardHeader
            count={state.kind === 'ready' ? state.items.length : 0}
            loading={state.kind === 'loading'}
          />

          {state.kind === 'loading' ? (
            <LoadingPanel label="Loading approvals…" />
          ) : state.kind === 'ready' && state.items.length === 0 ? (
            <EmptyPanel
              title="No quotes awaiting approval"
              description="When a buyer submits a quote above the approval threshold, it will appear here."
            />
          ) : state.kind === 'ready' ? (
            <View className="mt-3 overflow-hidden rounded-md border border-border-base bg-bg-surface">
              {state.items.slice(0, INLINE_CAP).map((item, idx) => {
                const isLast =
                  idx === Math.min(state.items.length, INLINE_CAP) - 1;
                const isExpanded = expandedQuoteId === item.quoteId;
                return (
                  <ApprovalRow
                    key={item.quoteId}
                    item={item}
                    isLast={isLast}
                    isExpanded={isExpanded}
                    pendingAction={pendingAction}
                    onToggle={() =>
                      setExpandedQuoteId(isExpanded ? null : item.quoteId)
                    }
                    onApprove={() => handleApprove(item)}
                    onRequestChanges={() => handleRequestChanges(item)}
                    onReject={() => handleReject(item)}
                  />
                );
              })}
              {state.items.length > INLINE_CAP && (
                <View className="border-t border-border-base bg-bg-subtle px-4 py-3">
                  <Text className="text-caption text-text-tertiary">
                    {state.items.length - INLINE_CAP} more pending — open the
                    desktop manager dashboard to review the full queue.
                  </Text>
                </View>
              )}
            </View>
          ) : null}
        </View>
      )}

      {state.kind === 'error' && (
        <View className="mt-6 px-5">
          <ErrorPanel
            message={state.message}
            onRetry={() => {
              void loadApprovals('refresh');
            }}
          />
        </View>
      )}

      {state.kind === 'unauthenticated' && (
        <View className="mt-6 px-5">
          <EmptyPanel
            title="Log in on desktop first"
            description="Mobile sign-in ships in a later update. Approve quotes from the web console in the meantime."
          />
        </View>
      )}

      {/* ---- Quick actions -------------------------------------------------- */}
      <View className="mt-8 px-5">
        <Text className="text-label uppercase text-text-tertiary">
          Quick actions
        </Text>
        <View className="mt-3 gap-3">
          <ActionTile
            title="Scan new bid"
            description="Snap a photo of a paper takeoff or pick a document"
            onPress={() => {
              router.push('/bids/new');
            }}
          />
          <ActionTile
            title="Open bids"
            description="Pipeline view — comparison matrix, margin stack"
            onPress={() => {
              router.navigate('/(tabs)/bids');
            }}
          />
        </View>
      </View>
    </ScrollView>
  );
}

// -----------------------------------------------------------------------------
// Approval card header (label + count chip)
// -----------------------------------------------------------------------------

function ApprovalCardHeader({
  count,
  loading,
}: {
  count: number;
  loading: boolean;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-label uppercase text-text-tertiary">
        Pending approvals
      </Text>
      {loading ? (
        <ActivityIndicator size="small" />
      ) : count > 0 ? (
        <StatChip label={`${count} pending`} tone="warn" />
      ) : (
        <StatChip label="Clear" tone="neutral" />
      )}
    </View>
  );
}

// -----------------------------------------------------------------------------
// ApprovalRow
// -----------------------------------------------------------------------------

interface ApprovalRowProps {
  item: ApprovalItem;
  isLast: boolean;
  isExpanded: boolean;
  pendingAction: string | null;
  onToggle: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onReject: () => void;
}

function ApprovalRow({
  item,
  isLast,
  isExpanded,
  pendingAction,
  onToggle,
  onApprove,
  onRequestChanges,
  onReject,
}: ApprovalRowProps) {
  const marginTone =
    item.blendedMarginPercent < 0.05 ? 'text-semantic-error' : 'text-text-primary';
  const rowBorder = isLast ? '' : 'border-b border-border-base';
  const anyActionPending = pendingAction?.startsWith(item.quoteId + ':');
  const approvePending = pendingAction === item.quoteId + ':approve';
  const changesPending = pendingAction === item.quoteId + ':request_changes';
  const rejectPending = pendingAction === item.quoteId + ':reject';

  return (
    <View className={rowBorder}>
      <Pressable
        onPress={onToggle}
        className="flex-row items-start justify-between px-4 py-3 active:bg-bg-elevated"
        accessibilityRole="button"
        accessibilityLabel={`${item.customer} — ${USD.format(item.total)}`}
      >
        <View className="flex-1 pr-3">
          <Text
            className="text-body font-semibold text-text-primary"
            numberOfLines={1}
          >
            {item.customer}
          </Text>
          <Text
            className="mt-0.5 text-body-sm text-text-secondary"
            numberOfLines={1}
          >
            {item.jobName ?? 'No job name'}
          </Text>
          <View className="mt-1 flex-row items-center gap-2">
            <Text className="text-caption text-text-tertiary" numberOfLines={1}>
              {item.trader}
            </Text>
            <Text className="text-caption text-text-tertiary">
              · {formatRelative(new Date(item.submittedAt).getTime())}
            </Text>
          </View>
        </View>
        <View className="items-end">
          <Text
            style={{ fontVariant: ['tabular-nums'] }}
            className={`text-body font-mono font-semibold ${marginTone}`}
          >
            {USD.format(item.total)}
          </Text>
          <View className="mt-1">
            <StatChip
              label={`${(item.blendedMarginPercent * 100).toFixed(1)}%`}
              tone={item.blendedMarginPercent < 0.05 ? 'error' : 'neutral'}
            />
          </View>
        </View>
      </Pressable>

      {isExpanded && (
        <View className="gap-2 border-t border-border-subtle bg-bg-subtle px-4 py-3">
          <ActionButton
            variant="primary"
            label="Approve"
            loading={approvePending}
            disabled={Boolean(anyActionPending) && !approvePending}
            onPress={onApprove}
          />
          <ActionButton
            variant="ghost"
            label="Request changes"
            loading={changesPending}
            disabled={Boolean(anyActionPending) && !changesPending}
            onPress={onRequestChanges}
          />
          <ActionButton
            variant="destructive"
            label="Reject"
            loading={rejectPending}
            disabled={Boolean(anyActionPending) && !rejectPending}
            onPress={onReject}
          />
        </View>
      )}
    </View>
  );
}

// -----------------------------------------------------------------------------
// ActionButton
// -----------------------------------------------------------------------------

type ActionVariant = 'primary' | 'ghost' | 'destructive';

interface ActionButtonProps {
  variant: ActionVariant;
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}

function ActionButton({
  variant,
  label,
  onPress,
  loading,
  disabled,
}: ActionButtonProps) {
  const variantClasses =
    variant === 'primary'
      ? 'bg-accent-primary active:bg-accent-secondary'
      : variant === 'destructive'
        ? 'bg-[rgba(232,84,72,0.12)] border border-[rgba(232,84,72,0.5)] active:bg-[rgba(232,84,72,0.22)]'
        : 'border border-border-strong active:bg-bg-elevated';

  const labelClass =
    variant === 'primary'
      ? 'text-body font-semibold text-text-inverse'
      : variant === 'destructive'
        ? 'text-body font-semibold text-semantic-error'
        : 'text-body text-text-primary';

  const spinnerColor = variant === 'primary' ? '#0A0E0C' : '#94A1A0';

  return (
    <Pressable
      onPress={onPress}
      disabled={loading || disabled}
      className={`flex-row items-center justify-center gap-2 rounded-sm px-5 py-2.5 ${variantClasses}`}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loading ? (
        <ActivityIndicator size="small" color={spinnerColor} />
      ) : (
        <Text className={labelClass}>{label}</Text>
      )}
    </Pressable>
  );
}

// -----------------------------------------------------------------------------
// Quick-action tile
// -----------------------------------------------------------------------------

function ActionTile({
  title,
  description,
  onPress,
}: {
  title: string;
  description: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="rounded-md border border-border-base bg-bg-surface px-4 py-4 active:bg-bg-elevated"
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <Text className="text-h4 text-text-primary">{title}</Text>
      <Text className="mt-1 text-body-sm text-text-secondary">
        {description}
      </Text>
    </Pressable>
  );
}

// -----------------------------------------------------------------------------
// StatChip
// -----------------------------------------------------------------------------

type ChipTone = 'neutral' | 'warn' | 'error';

function StatChip({ label, tone }: { label: string; tone: ChipTone }) {
  const toneClasses =
    tone === 'warn'
      ? 'bg-accent-warm/15 border-accent-warm/40'
      : tone === 'error'
        ? 'bg-[rgba(232,84,72,0.12)] border-[rgba(232,84,72,0.4)]'
        : 'bg-bg-elevated border-border-base';
  const textClass =
    tone === 'warn'
      ? 'text-accent-warm'
      : tone === 'error'
        ? 'text-semantic-error'
        : 'text-text-secondary';
  return (
    <View className={`rounded-sm border px-2 py-[2px] ${toneClasses}`}>
      <Text className={`text-caption font-semibold ${textClass}`}>{label}</Text>
    </View>
  );
}

// -----------------------------------------------------------------------------
// LoadingPanel / EmptyPanel / ErrorPanel (README §9)
// -----------------------------------------------------------------------------

function LoadingPanel({ label }: { label: string }) {
  return (
    <View className="mt-3 flex-row items-center gap-3 rounded-md border border-border-base bg-bg-surface px-4 py-3">
      <ActivityIndicator size="small" />
      <Text className="text-body-sm text-text-secondary">{label}</Text>
    </View>
  );
}

function EmptyPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <View className="mt-3 rounded-md border border-border-base bg-bg-surface px-4 py-5">
      <Text className="text-h4 text-text-primary">{title}</Text>
      <Text className="mt-1 text-body-sm text-text-secondary">
        {description}
      </Text>
    </View>
  );
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View className="rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-3">
      <Text className="text-body-sm text-semantic-error">{message}</Text>
      <Pressable
        onPress={onRetry}
        className="mt-2 self-start rounded-sm border border-border-strong px-3 py-1.5 active:bg-bg-elevated"
        accessibilityRole="button"
        accessibilityLabel="Retry"
      >
        <Text className="text-body-sm text-text-primary">Retry</Text>
      </Pressable>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  // ISO fallback for long tail — pending approvals older than 30 days are
  // unusual but not impossible. Keep them legible.
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return 'a while ago';
  }
}
