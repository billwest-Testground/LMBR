/**
 * NotificationsForm — /settings/notifications client island.
 *
 * Four toggle switches bound to the four keys on companies.notification_prefs.
 * Save is debounced — the user can click several toggles in a row and we
 * PUT once when they land on "Save changes".
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/cn';

type NotificationKey =
  | 'new_bid_received'
  | 'vendor_bid_submitted'
  | 'quote_approved_rejected'
  | 'vendor_nudge_due';

type Prefs = Record<NotificationKey, boolean>;

const TOGGLES: {
  key: NotificationKey;
  title: string;
  description: string;
}[] = [
  {
    key: 'new_bid_received',
    title: 'New bid received',
    description: 'Sends when the bids@ webhook ingests a fresh RFQ.',
  },
  {
    key: 'vendor_bid_submitted',
    title: 'Vendor pricing submitted',
    description:
      'Sends when a vendor completes the public digital form or a scan-back is parsed.',
  },
  {
    key: 'quote_approved_rejected',
    title: 'Quote approved / rejected',
    description:
      'Fires when a manager acts on a quote sitting in the approval queue.',
  },
  {
    key: 'vendor_nudge_due',
    title: 'Vendor nudge due',
    description:
      'Reminder that a vendor has an outstanding bid request and the due date is close.',
  },
];

export function NotificationsForm({ canEdit }: { canEdit: boolean }) {
  const [prefs, setPrefs] = React.useState<Prefs | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/settings/notifications', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Load failed (${res.status})`);
      }
      const body = (await res.json()) as Prefs;
      setPrefs(body);
      setDirty(false);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Notifications load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!prefs || !canEdit) return;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      const updated = (await res.json()) as Prefs;
      setPrefs(updated);
      setDirty(false);
      setSaveMessage('Saved.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-body-sm text-text-tertiary">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden={true} />
        Loading…
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="rounded-sm border border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.1)] p-4 text-body-sm text-semantic-error">
        {loadError}
      </div>
    );
  }
  if (!prefs) return null;

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-6">
      {!canEdit && (
        <div className="rounded-sm border border-border-base bg-bg-elevated p-3 text-body-sm text-text-tertiary">
          Read-only view. Manager or owner role required to edit notifications.
        </div>
      )}

      <section className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-base bg-bg-surface shadow-sm">
        {TOGGLES.map((t) => (
          <ToggleRow
            key={t.key}
            title={t.title}
            description={t.description}
            checked={prefs[t.key]}
            disabled={!canEdit}
            onChange={(value) => {
              setPrefs({ ...prefs, [t.key]: value });
              setDirty(true);
              setSaveMessage(null);
            }}
          />
        ))}
      </section>

      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {saveMessage && (
            <span className="text-body-sm text-accent-primary">{saveMessage}</span>
          )}
          {saveError && (
            <span className="text-body-sm text-semantic-error">{saveError}</span>
          )}
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save changes
          </Button>
        </div>
      )}
    </form>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-start justify-between gap-4 p-5',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-body text-text-primary">{title}</span>
        <span className="text-body-sm text-text-secondary">{description}</span>
      </div>
      <span
        className={cn(
          'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors duration-micro',
          checked
            ? 'border-accent-primary bg-accent-primary'
            : 'border-border-base bg-bg-elevated',
          disabled && 'opacity-40',
        )}
      >
        <input
          type="checkbox"
          role="switch"
          className="absolute inset-0 h-full w-full cursor-inherit opacity-0"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-checked={checked}
        />
        <span
          aria-hidden={true}
          className={cn(
            'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-bg-surface shadow transition-transform duration-micro',
            checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
          )}
        />
      </span>
    </label>
  );
}
