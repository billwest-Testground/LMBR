/**
 * IntegrationsClient — client island for /settings/integrations.
 *
 * Purpose:  Renders and drives the four sections of the integrations
 *           settings page:
 *             1. Personal Outlook connection — connect / disconnect /
 *                reconnect, plus a small banner that reacts to the
 *                ?connected=1 / ?error=... flags dropped by the OAuth
 *                callback route.
 *             2. Shared bids@ mailbox — subscribe / disconnect. Only
 *                rendered for manager / owner.
 *             3. Team roster — read-only table of every teammate's
 *                connection status. Manager / owner only.
 *             4. Email subject overrides — edit + reset the three
 *                per-company subject-line columns. Manager / owner
 *                only.
 *
 *           Pulls all state in one round trip via
 *           GET /api/auth/outlook/status; every mutation hits a narrow
 *           endpoint and re-fetches the same payload so the UI stays
 *           in sync with the DB without a full page reload.
 *
 * Inputs:   none (loads data via fetch on mount).
 * Outputs:  JSX.
 * Agent/API: GET  /api/auth/outlook/status
 *            GET  /api/auth/outlook (mint OAuth url + redirect)
 *            DELETE /api/auth/outlook (disconnect self)
 *            POST /api/webhook/outlook/subscribe (manager)
 *            DELETE /api/webhook/outlook/subscribe (manager)
 *            PUT  /api/settings/email-subjects (manager)
 * Imports:  react, next/navigation, lucide-react, ../../../components/ui/button,
 *           ../../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Mail,
  PencilLine,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/cn';

// ---------------------------------------------------------------------------
// Status payload shape (keep in sync with
// apps/web/src/app/api/auth/outlook/status/route.ts)
// ---------------------------------------------------------------------------

type PersonalStatus = 'connected' | 'needs_reauth' | 'not_connected';
type SubscriptionStatusKind = 'active' | 'degraded' | 'expired';
type TeamMemberStatusKind = 'connected' | 'needs_reauth' | 'not_connected';

interface StatusResponse {
  personal: {
    status: PersonalStatus;
    email: string | null;
    displayName: string | null;
    connectedAt: string | null;
    lastUsedAt: string | null;
  };
  subscription: {
    status: SubscriptionStatusKind;
    mailboxEmail: string;
    subscriptionId: string;
    expiresAt: string;
    lastRenewedAt: string | null;
    emailsThisMonth: number;
  } | null;
  team: Array<{
    userId: string;
    fullName: string | null;
    email: string;
    roles: string[];
    status: TeamMemberStatusKind;
    lastUsedAt: string | null;
  }>;
  counters: { emailsThisMonth: number };
  subjects: {
    dispatch: string | null;
    nudge: string | null;
    quote: string | null;
  };
  isManagerOrOwner: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IntegrationsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [state, setState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; data: StatusResponse }
  >({ kind: 'loading' });

  const [banner, setBanner] = React.useState<
    | { kind: 'success'; message: string }
    | { kind: 'error'; message: string }
    | null
  >(null);

  // Read the ?connected / ?error flags set by the OAuth callback and
  // scrub them from the URL so refresh doesn't re-trigger the banner.
  React.useEffect(() => {
    if (searchParams.get('connected') === '1') {
      setBanner({
        kind: 'success',
        message: 'Outlook connected.',
      });
      cleanQueryFlags(router);
    } else {
      const err = searchParams.get('error');
      if (err) {
        setBanner({
          kind: 'error',
          message:
            err === 'auth_denied'
              ? 'Microsoft sign-in was cancelled or denied.'
              : 'Outlook connection failed. Please try again.',
        });
        cleanQueryFlags(router);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = React.useCallback(async () => {
    try {
      const res = await fetch('/api/auth/outlook/status', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: 'error',
          message: body.error ?? `Status request failed (${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as StatusResponse;
      setState({ kind: 'ready', data });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Status request failed.',
      });
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  if (state.kind === 'loading') {
    return <LoadingPanel />;
  }
  if (state.kind === 'error') {
    return <ErrorPanel message={state.message} onRetry={() => void reload()} />;
  }

  const data = state.data;

  return (
    <div className="flex flex-col gap-6">
      {banner ? <Banner banner={banner} onDismiss={() => setBanner(null)} /> : null}

      <PersonalConnectionCard
        personal={data.personal}
        onChanged={() => void reload()}
      />

      {data.isManagerOrOwner ? (
        <>
          <SubscriptionCard
            subscription={data.subscription}
            emailsThisMonth={data.counters.emailsThisMonth}
            personalStatus={data.personal.status}
            onChanged={() => void reload()}
          />
          <TeamSection team={data.team} />
          <SubjectEditorCard
            initial={data.subjects}
            onSaved={() => void reload()}
          />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Personal connection card
// ---------------------------------------------------------------------------

function PersonalConnectionCard({
  personal,
  onChanged,
}: {
  personal: StatusResponse['personal'];
  onChanged: () => void;
}) {
  const [submitting, setSubmitting] = React.useState<
    null | 'connecting' | 'disconnecting'
  >(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);

  async function connect() {
    setSubmitting('connecting');
    setError(null);
    try {
      const res = await fetch('/api/auth/outlook', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not start Outlook connect.');
        setSubmitting(null);
        return;
      }
      const data = (await res.json()) as { authUrl?: string };
      if (!data.authUrl) {
        setError('Outlook auth URL missing.');
        setSubmitting(null);
        return;
      }
      window.location.href = data.authUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed.');
      setSubmitting(null);
    }
  }

  async function disconnect() {
    setSubmitting('disconnecting');
    setError(null);
    try {
      const res = await fetch('/api/auth/outlook', { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Disconnect failed.');
      } else {
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed.');
    } finally {
      setSubmitting(null);
      setConfirmingDisconnect(false);
    }
  }

  // --- STATE A: not connected --------------------------------------------
  if (personal.status === 'not_connected') {
    return (
      <Card>
        <div className="flex items-start gap-4">
          <IconBubble tone="neutral">
            <Mail className="h-5 w-5" aria-hidden="true" />
          </IconBubble>
          <div className="flex-1">
            <h2 className="text-h3 text-text-primary">
              Connect your Outlook account
            </h2>
            <p className="mt-1 text-body text-text-secondary">
              Send vendor dispatches, nudges, and quotes from your own email
              address. Vendors and customers see emails from you, not from a
              generic LMBR address.
            </p>
            {error ? (
              <p className="mt-3 text-body-sm text-semantic-error">{error}</p>
            ) : null}
            <div className="mt-4">
              <Button
                variant="primary"
                onClick={() => void connect()}
                loading={submitting === 'connecting'}
              >
                Connect Outlook
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  // --- STATE C: needs reauth ---------------------------------------------
  if (personal.status === 'needs_reauth') {
    return (
      <Card>
        <div className="flex items-start gap-4">
          <IconBubble tone="warning">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </IconBubble>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-h3 text-text-primary">
                {personal.displayName ?? 'Outlook'}
              </h2>
              <StatusBadge tone="warning">Needs reauth</StatusBadge>
            </div>
            {personal.email ? (
              <p className="text-body-sm text-text-secondary">{personal.email}</p>
            ) : null}
            <p className="mt-2 text-body text-text-secondary">
              Your Outlook connection needs to be renewed. Emails from LMBR
              on your behalf are paused until you reconnect.
            </p>
            {error ? (
              <p className="mt-3 text-body-sm text-semantic-error">{error}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => void connect()}
                loading={submitting === 'connecting'}
              >
                Reconnect Outlook
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmingDisconnect(true)}
              >
                Disconnect
              </Button>
            </div>
          </div>
        </div>
        {confirmingDisconnect ? (
          <DisconnectConfirm
            onCancel={() => setConfirmingDisconnect(false)}
            onConfirm={() => void disconnect()}
            loading={submitting === 'disconnecting'}
          />
        ) : null}
      </Card>
    );
  }

  // --- STATE B: connected ------------------------------------------------
  return (
    <Card>
      <div className="flex items-start gap-4">
        <IconBubble tone="success">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
        </IconBubble>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h3 text-text-primary">
              {personal.displayName ?? 'Outlook'}
            </h2>
            <StatusBadge tone="success">Connected</StatusBadge>
          </div>
          {personal.email ? (
            <p className="text-body-sm text-text-secondary">{personal.email}</p>
          ) : null}
          <div className="mt-3 grid grid-cols-1 gap-1 text-body-sm text-text-tertiary sm:grid-cols-2">
            <MetaRow
              label="Connected"
              value={
                personal.connectedAt
                  ? formatRelative(personal.connectedAt)
                  : '—'
              }
            />
            <MetaRow
              label="Last used"
              value={
                personal.lastUsedAt ? formatRelative(personal.lastUsedAt) : 'not yet'
              }
            />
          </div>
          {error ? (
            <p className="mt-3 text-body-sm text-semantic-error">{error}</p>
          ) : null}
          <div className="mt-4">
            <Button
              variant="destructive"
              onClick={() => setConfirmingDisconnect(true)}
            >
              Disconnect
            </Button>
          </div>
        </div>
      </div>
      {confirmingDisconnect ? (
        <DisconnectConfirm
          onCancel={() => setConfirmingDisconnect(false)}
          onConfirm={() => void disconnect()}
          loading={submitting === 'disconnecting'}
        />
      ) : null}
    </Card>
  );
}

function DisconnectConfirm({
  onCancel,
  onConfirm,
  loading,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <div className="mt-4 rounded-sm border border-border-subtle bg-bg-subtle p-4">
      <p className="text-body-sm text-text-secondary">
        Disconnecting will prevent LMBR from sending emails on your behalf.
        Vendor dispatches and quote deliveries will show as "email not sent"
        until you reconnect.
      </p>
      <div className="mt-3 flex gap-2">
        <Button variant="destructive" onClick={onConfirm} loading={loading}>
          Yes, disconnect
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscription card
// ---------------------------------------------------------------------------

function SubscriptionCard({
  subscription,
  emailsThisMonth,
  personalStatus,
  onChanged,
}: {
  subscription: StatusResponse['subscription'];
  emailsThisMonth: number;
  personalStatus: PersonalStatus;
  onChanged: () => void;
}) {
  const [mailbox, setMailbox] = React.useState('');
  const [submitting, setSubmitting] = React.useState<
    null | 'subscribing' | 'disconnecting'
  >(null);
  const [error, setError] = React.useState<string | null>(null);
  const canConnectMailbox = personalStatus === 'connected';

  async function subscribe(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setSubmitting('subscribing');
    setError(null);
    try {
      const res = await fetch('/api/webhook/outlook/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailboxEmail: mailbox.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error === 'outlook_not_connected'
            ? 'Connect your own Outlook account above first — the mailbox subscription is created through that connection.'
            : (body.error ?? `Subscribe failed (${res.status})`),
        );
        setSubmitting(null);
        return;
      }
      setMailbox('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Subscribe failed.');
    } finally {
      setSubmitting(null);
    }
  }

  async function disconnect() {
    setSubmitting('disconnecting');
    setError(null);
    try {
      const res = await fetch('/api/webhook/outlook/subscribe', {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Disconnect failed.');
      } else {
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed.');
    } finally {
      setSubmitting(null);
    }
  }

  // --- STATE A: no subscription ------------------------------------------
  if (!subscription) {
    return (
      <Card>
        <div className="flex items-start gap-4">
          <IconBubble tone="neutral">
            <Inbox className="h-5 w-5" aria-hidden="true" />
          </IconBubble>
          <div className="flex-1">
            <h2 className="text-h3 text-text-primary">
              Set up inbound bid capture
            </h2>
            <p className="mt-1 text-body text-text-secondary">
              Connect a mailbox to automatically capture lumber lists forwarded
              to bids@[your-company].com. When a list arrives, LMBR creates a
              bid and starts extraction automatically.
            </p>
            {!canConnectMailbox ? (
              <p className="mt-2 text-body-sm text-semantic-warning">
                Connect your personal Outlook account above first.
              </p>
            ) : null}
            <form
              onSubmit={(ev) => void subscribe(ev)}
              className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <input
                type="email"
                required
                disabled={!canConnectMailbox || submitting === 'subscribing'}
                placeholder="bids@yourcompany.com"
                value={mailbox}
                onChange={(e) => setMailbox(e.target.value)}
                className={cn(
                  'min-w-0 flex-1 rounded-sm border border-border-strong bg-bg-input',
                  'px-3 py-2 text-body text-text-primary',
                  'focus-visible:outline-none focus-visible:shadow-accent',
                  'disabled:opacity-60',
                )}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={!canConnectMailbox}
                loading={submitting === 'subscribing'}
              >
                Connect mailbox
              </Button>
            </form>
            {error ? (
              <p className="mt-3 text-body-sm text-semantic-error">{error}</p>
            ) : null}
          </div>
        </div>
      </Card>
    );
  }

  // --- STATE B or C: existing subscription --------------------------------
  const expiresMs = new Date(subscription.expiresAt).getTime();
  const renewsInHours = Math.max(
    0,
    Math.round((expiresMs - Date.now()) / 3_600_000),
  );
  const isExpired = subscription.status === 'expired' || expiresMs <= Date.now();
  const isDegraded = subscription.status === 'degraded';
  const badgeTone: BadgeTone = isExpired
    ? 'error'
    : isDegraded
      ? 'warning'
      : 'success';
  const badgeLabel = isExpired
    ? 'Disconnected'
    : isDegraded
      ? 'Degraded'
      : 'Active';

  const renewsTone: 'neutral' | 'warning' | 'error' = isExpired
    ? 'error'
    : renewsInHours < 24
      ? 'warning'
      : 'neutral';

  return (
    <Card>
      <div className="flex items-start gap-4">
        <IconBubble tone={isExpired || isDegraded ? 'warning' : 'success'}>
          <Inbox className="h-5 w-5" aria-hidden="true" />
        </IconBubble>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h3 text-text-primary">Inbound bid capture</h2>
            <StatusBadge tone={badgeTone}>{badgeLabel}</StatusBadge>
          </div>
          <p className="text-body-sm text-text-secondary">
            {subscription.mailboxEmail || '—'}
          </p>
          <div className="mt-3 grid grid-cols-1 gap-1 text-body-sm sm:grid-cols-2">
            <MetaRow
              label="Monitoring since"
              value={
                subscription.lastRenewedAt
                  ? formatAbsolute(subscription.lastRenewedAt)
                  : '—'
              }
            />
            <MetaRow
              label={isExpired ? 'Expired' : 'Renews in'}
              value={
                isExpired
                  ? formatRelative(subscription.expiresAt)
                  : `${renewsInHours}h`
              }
              tone={renewsTone}
            />
            <MetaRow
              label="Emails processed"
              value={`${emailsThisMonth} this month`}
            />
          </div>
          {isExpired ? (
            <p className="mt-3 text-body-sm text-text-secondary">
              Emails received during this period are still in your inbox and
              can be manually forwarded to reprocess.
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 text-body-sm text-semantic-error">{error}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {isExpired ? (
              <Button
                variant="primary"
                onClick={() => void disconnect().then(() => onChanged())}
                loading={submitting === 'disconnecting'}
              >
                Reset subscription
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => void disconnect()}
                loading={submitting === 'disconnecting'}
              >
                Disconnect mailbox
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Team roster
// ---------------------------------------------------------------------------

function TeamSection({ team }: { team: StatusResponse['team'] }) {
  if (team.length === 0) return null;

  return (
    <Card>
      <div className="flex items-start gap-4">
        <IconBubble tone="neutral">
          <Users className="h-5 w-5" aria-hidden="true" />
        </IconBubble>
        <div className="flex-1">
          <h2 className="text-h3 text-text-primary">Team connections</h2>
          <p className="mt-1 text-body-sm text-text-secondary">
            Read-only view of every teammate's Outlook status. You cannot
            disconnect another user's account — they manage their own
            connection from this page.
          </p>
          <div className="mt-4 overflow-hidden rounded-sm border border-border-subtle">
            <table className="w-full border-separate border-spacing-0 text-body-sm">
              <thead>
                <tr className="bg-bg-surface">
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Email</Th>
                  <Th>Status</Th>
                  <Th>Last used</Th>
                </tr>
              </thead>
              <tbody>
                {team.map((m) => (
                  <tr key={m.userId}>
                    <Td>{m.fullName ?? m.email}</Td>
                    <Td className="text-text-secondary">
                      {m.roles.length > 0 ? prettyRoles(m.roles) : '—'}
                    </Td>
                    <Td className="text-text-secondary">{m.email}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot status={m.status} />
                        <span className="text-text-primary">
                          {statusLabel(m.status)}
                        </span>
                      </span>
                    </Td>
                    <Td className="text-text-tertiary">
                      {m.lastUsedAt ? formatRelative(m.lastUsedAt) : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Subject editor
// ---------------------------------------------------------------------------

interface SubjectEditorCardProps {
  initial: StatusResponse['subjects'];
  onSaved: () => void;
}

function SubjectEditorCard({ initial, onSaved }: SubjectEditorCardProps) {
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState(initial);
  React.useEffect(() => {
    setValues(initial);
  }, [initial]);

  const [savingKey, setSavingKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function saveOne(key: 'dispatch' | 'nudge' | 'quote') {
    setSavingKey(key);
    setError(null);
    try {
      const body: Record<string, string | null> = {};
      body[key] = values[key];
      const res = await fetch('/api/settings/email-subjects', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `Save failed (${res.status})`);
      } else {
        onSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <IconBubble tone="neutral">
          <PencilLine className="h-5 w-5" aria-hidden="true" />
        </IconBubble>
        <div className="flex-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-4 text-left"
          >
            <div>
              <h2 className="text-h3 text-text-primary">Email templates</h2>
              <p className="mt-1 text-body-sm text-text-secondary">
                Override the subject line on each outbound template. Empty =
                use the default. Full body editor lands in Prompt 11.
              </p>
            </div>
            <span className="text-body-sm text-text-tertiary">
              {open ? 'Hide' : 'Show'}
            </span>
          </button>

          {open ? (
            <div className="mt-4 flex flex-col gap-4">
              <SubjectRow
                label="Vendor dispatch"
                defaultHint="Lumber bid request — {job} — due {date}"
                value={values.dispatch ?? ''}
                onChange={(v) =>
                  setValues((prev) => ({ ...prev, dispatch: v || null }))
                }
                saving={savingKey === 'dispatch'}
                onSave={() => void saveOne('dispatch')}
                onReset={() => {
                  setValues((prev) => ({ ...prev, dispatch: null }));
                  void saveOne('dispatch');
                }}
                isOverridden={values.dispatch !== null}
              />
              <SubjectRow
                label="Vendor nudge"
                defaultHint="Following up — {job} bid due in {hours} hours"
                value={values.nudge ?? ''}
                onChange={(v) =>
                  setValues((prev) => ({ ...prev, nudge: v || null }))
                }
                saving={savingKey === 'nudge'}
                onSave={() => void saveOne('nudge')}
                onReset={() => {
                  setValues((prev) => ({ ...prev, nudge: null }));
                  void saveOne('nudge');
                }}
                isOverridden={values.nudge !== null}
              />
              <SubjectRow
                label="Quote delivery"
                defaultHint="Quote for {job} — valid until {date}"
                value={values.quote ?? ''}
                onChange={(v) =>
                  setValues((prev) => ({ ...prev, quote: v || null }))
                }
                saving={savingKey === 'quote'}
                onSave={() => void saveOne('quote')}
                onReset={() => {
                  setValues((prev) => ({ ...prev, quote: null }));
                  void saveOne('quote');
                }}
                isOverridden={values.quote !== null}
              />
              {error ? (
                <p className="text-body-sm text-semantic-error">{error}</p>
              ) : null}
              <p className="text-body-sm text-text-tertiary">
                Note: literal subject only — no placeholder substitution yet.
                A template editor with variables is coming in Prompt 11.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function SubjectRow({
  label,
  defaultHint,
  value,
  onChange,
  saving,
  onSave,
  onReset,
  isOverridden,
}: {
  label: string;
  defaultHint: string;
  value: string;
  onChange: (next: string) => void;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  isOverridden: boolean;
}) {
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-subtle p-3">
      <div className="flex items-center justify-between">
        <label className="text-label uppercase text-text-tertiary">
          {label}
        </label>
        {isOverridden ? (
          <StatusBadge tone="accent">Overridden</StatusBadge>
        ) : (
          <span className="text-body-sm text-text-tertiary">Default</span>
        )}
      </div>
      <input
        type="text"
        value={value}
        maxLength={240}
        onChange={(e) => onChange(e.target.value)}
        placeholder={defaultHint}
        disabled={saving}
        className={cn(
          'mt-2 w-full rounded-sm border border-border-strong bg-bg-input',
          'px-3 py-2 text-body text-text-primary placeholder:text-text-tertiary',
          'focus-visible:outline-none focus-visible:shadow-accent',
          'disabled:opacity-60',
        )}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={saving}
        >
          Save
        </Button>
        {isOverridden ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={saving}
          >
            Reset to default
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared small components + helpers
// ---------------------------------------------------------------------------

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
      {children}
    </div>
  );
}

type BadgeTone = 'success' | 'warning' | 'error' | 'neutral' | 'accent';

function IconBubble({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'neutral';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-[rgba(29,184,122,0.12)] text-semantic-success'
      : tone === 'warning'
        ? 'bg-[rgba(232,172,72,0.12)] text-semantic-warning'
        : 'bg-bg-subtle text-text-tertiary';
  return (
    <div
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-sm',
        toneClass,
      )}
    >
      {children}
    </div>
  );
}

function StatusBadge({
  tone,
  children,
}: {
  tone: BadgeTone;
  children: React.ReactNode;
}) {
  const toneClass = {
    success:
      'bg-[rgba(29,184,122,0.12)] text-semantic-success border-[rgba(29,184,122,0.3)]',
    warning:
      'bg-[rgba(232,172,72,0.12)] text-semantic-warning border-[rgba(232,172,72,0.3)]',
    error:
      'bg-[rgba(192,57,43,0.12)] text-semantic-error border-[rgba(192,57,43,0.3)]',
    neutral: 'bg-bg-subtle text-text-tertiary border-border-subtle',
    accent:
      'bg-[rgba(29,184,122,0.08)] text-accent-primary border-[rgba(29,184,122,0.3)]',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[4px] border px-2 py-0.5 text-label',
        toneClass,
      )}
    >
      {children}
    </span>
  );
}

function StatusDot({ status }: { status: TeamMemberStatusKind }) {
  const toneClass =
    status === 'connected'
      ? 'bg-semantic-success'
      : status === 'needs_reauth'
        ? 'bg-semantic-warning'
        : 'bg-text-tertiary';
  return (
    <span
      className={cn('inline-block h-2 w-2 rounded-full', toneClass)}
      aria-hidden="true"
    />
  );
}

function MetaRow({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warning' | 'error';
}) {
  const toneClass =
    tone === 'warning'
      ? 'text-semantic-warning'
      : tone === 'error'
        ? 'text-semantic-error'
        : 'text-text-secondary';
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-label uppercase text-text-tertiary">{label}</span>
      <span className={cn('text-body-sm', toneClass)}>{value}</span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-border-subtle px-3 py-2 text-left text-label uppercase text-text-tertiary">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td
      className={cn(
        'border-b border-border-subtle px-3 py-2 text-text-primary',
        className,
      )}
    >
      {children}
    </td>
  );
}

function LoadingPanel() {
  return (
    <div className="rounded-md border border-border-base bg-bg-surface p-6 shadow-sm">
      <p className="text-body text-text-secondary">Loading integrations…</p>
    </div>
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
    <div className="rounded-md border border-border-base bg-bg-surface p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <ShieldAlert className="h-6 w-6 shrink-0 text-semantic-error" aria-hidden="true" />
        <div className="flex-1">
          <h2 className="text-h3 text-text-primary">
            Could not load integrations
          </h2>
          <p className="mt-1 text-body-sm text-text-secondary">{message}</p>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Banner({
  banner,
  onDismiss,
}: {
  banner: { kind: 'success' | 'error'; message: string };
  onDismiss: () => void;
}) {
  const tone =
    banner.kind === 'success'
      ? 'border-[rgba(29,184,122,0.3)] bg-[rgba(29,184,122,0.08)] text-semantic-success'
      : 'border-[rgba(192,57,43,0.3)] bg-[rgba(192,57,43,0.08)] text-semantic-error';
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-sm border px-3 py-2 text-body-sm',
        tone,
      )}
    >
      <span>{banner.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-sm p-1 hover:bg-bg-elevated"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function cleanQueryFlags(_router: ReturnType<typeof useRouter>): void {
  // Use history.replaceState directly — Next.js typedRoutes rejects the
  // arbitrary-string target, and a silent URL cleanup doesn't need a
  // re-render anyway (React state already drives the UI).
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('connected');
  url.searchParams.delete('error');
  window.history.replaceState({}, '', url.pathname + (url.search || ''));
}

function prettyRoles(roles: string[]): string {
  return roles
    .map((r) =>
      r
        .split('_')
        .map((piece) => piece.charAt(0).toUpperCase() + piece.slice(1))
        .join('-'),
    )
    .join(', ');
}

function statusLabel(status: TeamMemberStatusKind): string {
  if (status === 'connected') return 'Connected';
  if (status === 'needs_reauth') return 'Needs reauth';
  return 'Not connected';
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffMs = Date.now() - t;
  const sign = diffMs >= 0 ? 1 : -1;
  const abs = Math.abs(diffMs);
  const mins = Math.floor(abs / 60_000);
  if (mins < 1) return sign >= 0 ? 'just now' : 'in <1m';
  if (mins < 60) return sign >= 0 ? `${mins}m ago` : `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return sign >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return sign >= 0 ? `${days}d ago` : `in ${days}d`;
  const months = Math.floor(days / 30);
  return sign >= 0 ? `${months}mo ago` : `in ${months}mo`;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}
