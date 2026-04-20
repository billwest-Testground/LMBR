/**
 * PricingForm — /settings/pricing client island.
 *
 * Loads current quote settings, edits in-place, PUTs on save. Presets
 * are stored as fractions (0.08 = 8%) but surfaced to the user as
 * integer percentages; the form handles the conversion.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Loader2, Plus, X } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';

interface PricingSettings {
  approvalThresholdDollars: number;
  minMarginPercent: number;
  marginPresets: number[];
}

function percentToFraction(value: string): number | null {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return Math.round(n * 100) / 10_000;
}

function fractionToPercentString(fraction: number): string {
  return (fraction * 100).toFixed(2).replace(/\.?0+$/, '');
}

export function PricingForm({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = React.useState<PricingSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const [newPreset, setNewPreset] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/settings/pricing', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Load failed (${res.status})`);
      }
      const body = (await res.json()) as PricingSettings;
      setData(body);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Pricing load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!data || !canEdit) return;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/settings/pricing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalThresholdDollars: data.approvalThresholdDollars,
          minMarginPercent: data.minMarginPercent,
          marginPresets: data.marginPresets,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      const updated = (await res.json()) as PricingSettings;
      setData(updated);
      setSaveMessage('Saved.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function addPreset() {
    if (!data) return;
    const fraction = percentToFraction(newPreset);
    if (fraction === null) {
      setSaveError('Preset must be a number between 0 and 100.');
      return;
    }
    const next = Array.from(new Set([...data.marginPresets, fraction])).sort(
      (a, b) => a - b,
    );
    setData({ ...data, marginPresets: next });
    setNewPreset('');
    setSaveError(null);
  }

  function removePreset(fraction: number) {
    if (!data) return;
    setData({
      ...data,
      marginPresets: data.marginPresets.filter((p) => p !== fraction),
    });
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
  if (!data) return null;

  const minMarginPercent = fractionToPercentString(data.minMarginPercent);

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-6">
      {!canEdit && (
        <div className="rounded-sm border border-border-base bg-bg-elevated p-3 text-body-sm text-text-tertiary">
          Read-only view. Manager or owner role required to edit pricing settings.
        </div>
      )}

      <section className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-1.5">
          <h2 className="text-h3 text-text-primary">Approval gate</h2>
          <p className="text-body-sm text-text-secondary">
            Quotes with a grand total (subtotal + taxes) above this dollar
            amount route to a manager for approval before release.
          </p>
        </div>
        <div className="max-w-xs">
          <Label htmlFor="approval-threshold">Approval threshold (USD)</Label>
          <Input
            id="approval-threshold"
            type="number"
            min={0}
            max={10_000_000}
            step={100}
            value={data.approvalThresholdDollars}
            disabled={!canEdit}
            onChange={(e) =>
              setData((prev) =>
                prev
                  ? {
                      ...prev,
                      approvalThresholdDollars: Number(e.target.value) || 0,
                    }
                  : prev,
              )
            }
          />
        </div>
      </section>

      <section className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-1.5">
          <h2 className="text-h3 text-text-primary">Minimum margin</h2>
          <p className="text-body-sm text-text-secondary">
            Blended-margin floor. Quotes below this value are flagged
            <span className="font-mono"> belowMinimumMargin</span> on the
            margin stack; managers can still override.
          </p>
        </div>
        <div className="max-w-xs">
          <Label htmlFor="min-margin">Minimum blended margin (%)</Label>
          <Input
            id="min-margin"
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={minMarginPercent}
            disabled={!canEdit}
            onChange={(e) => {
              const fraction = percentToFraction(e.target.value);
              if (fraction === null) return;
              setData((prev) => (prev ? { ...prev, minMarginPercent: fraction } : prev));
            }}
          />
        </div>
      </section>

      <section className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-1.5">
          <h2 className="text-h3 text-text-primary">Margin presets</h2>
          <p className="text-body-sm text-text-secondary">
            Preset ladder shown on the margin-stack screen. Up to 10
            entries. Stored and applied as percentages.
          </p>
        </div>
        <ul className="mb-4 flex flex-wrap gap-2">
          {data.marginPresets.length === 0 && (
            <li className="text-body-sm text-text-tertiary">No presets configured.</li>
          )}
          {data.marginPresets.map((fraction) => (
            <li
              key={fraction}
              className="inline-flex items-center gap-2 rounded-full border border-border-base bg-bg-elevated px-3 py-1 text-body-sm text-text-primary"
            >
              <span className="font-mono tabular-nums">
                {fractionToPercentString(fraction)}%
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => removePreset(fraction)}
                  className="text-text-tertiary transition-colors duration-micro hover:text-semantic-error"
                  aria-label={`Remove preset ${fractionToPercentString(fraction)}%`}
                >
                  <X className="h-3 w-3" aria-hidden={true} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="new-preset">New preset (%)</Label>
              <Input
                id="new-preset"
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={newPreset}
                onChange={(e) => setNewPreset(e.target.value)}
                className="w-32"
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addPreset}
              disabled={data.marginPresets.length >= 10}
            >
              <Plus className="h-4 w-4" aria-hidden={true} />
              Add
            </Button>
          </div>
        )}
      </section>

      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {saveMessage && (
            <span className="text-body-sm text-accent-primary">{saveMessage}</span>
          )}
          {saveError && (
            <span className="text-body-sm text-semantic-error">{saveError}</span>
          )}
          <Button type="submit" loading={saving}>
            Save changes
          </Button>
        </div>
      )}
    </form>
  );
}
