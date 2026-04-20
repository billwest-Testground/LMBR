/**
 * CompanyForm — /settings/company client island.
 *
 * Purpose:  Renders the company profile form. Fetches current values
 *           from GET /api/settings/company on mount; PUTs text fields
 *           on save; POSTs /logo for uploads and DELETEs /logo for
 *           clearing. Non-editors (anyone not manager/owner) see every
 *           field in read-only mode — the inputs are disabled and the
 *           save button is hidden.
 *
 *           Design-system primitives only (Input / Label / Button).
 *           Native <select> is used for the timezone + consolidation
 *           mode dropdowns because the UI kit does not ship a Select
 *           yet (per survey). Region picker is a checkbox grid keyed
 *           off US_REGIONS.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Loader2, UploadCloud, X } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { cn } from '../../../lib/cn';

import { COMPANY_TIMEZONES, US_REGIONS } from '@lmbr/config';

type ConsolidationMode = 'structured' | 'consolidated' | 'phased' | 'hybrid';

interface CompanySettings {
  name: string;
  timezone: string;
  logoUrl: string | null;
  defaultConsolidationMode: ConsolidationMode;
  jobRegionsServed: string[];
}

const CONSOLIDATION_MODES: { value: ConsolidationMode; label: string; hint: string }[] = [
  { value: 'structured',    label: 'Structured',    hint: 'Preserve building / phase breaks as received.' },
  { value: 'consolidated',  label: 'Consolidated',  hint: 'Aggregate identical species / dim / grade across the job.' },
  { value: 'phased',        label: 'Phased',        hint: 'Quote each phase independently.' },
  { value: 'hybrid',        label: 'Hybrid',        hint: 'Vendor sees consolidated tally; customer sees breakdown.' },
];

export function CompanyForm({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = React.useState<CompanySettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [logoBusy, setLogoBusy] = React.useState(false);
  const [logoError, setLogoError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/settings/company', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load (${res.status})`);
      }
      const body = (await res.json()) as CompanySettings;
      setData(body);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load company settings');
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
      const res = await fetch('/api/settings/company', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          timezone: data.timezone,
          defaultConsolidationMode: data.defaultConsolidationMode,
          jobRegionsServed: data.jobRegionsServed,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      const updated = (await res.json()) as CompanySettings;
      setData(updated);
      setSaveMessage('Saved.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoUpload(file: File) {
    if (!canEdit) return;
    setLogoBusy(true);
    setLogoError(null);
    try {
      const form = new FormData();
      form.append('logo', file);
      const res = await fetch('/api/settings/company/logo', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
      const { logoUrl } = (await res.json()) as { logoUrl: string };
      setData((prev) => (prev ? { ...prev, logoUrl } : prev));
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLogoBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleLogoClear() {
    if (!canEdit) return;
    setLogoBusy(true);
    setLogoError(null);
    try {
      const res = await fetch('/api/settings/company/logo', { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Clear failed (${res.status})`);
      }
      setData((prev) => (prev ? { ...prev, logoUrl: null } : prev));
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Clear failed');
    } finally {
      setLogoBusy(false);
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
      <div className="rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.1)] p-4 text-body-sm text-semantic-error">
        {loadError}
      </div>
    );
  }
  if (!data) return null;

  return (
    <form
      onSubmit={handleSave}
      className="flex flex-col gap-6"
      aria-disabled={!canEdit}
    >
      {!canEdit && (
        <div className="rounded-sm border border-border-base bg-bg-elevated p-3 text-body-sm text-text-tertiary">
          Read-only view. Manager or owner role required to edit company settings.
        </div>
      )}

      {/* Logo */}
      <section className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-1.5">
          <h2 className="text-h3 text-text-primary">Logo</h2>
          <p className="text-body-sm text-text-secondary">
            Embedded on customer-facing quote PDFs. Recommended 512×512 PNG or
            SVG. 2MB max.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-sm border border-border-base bg-bg-elevated">
            {data.logoUrl ? (
              // Server-rendered <img> — next/image is overkill here since the
              // URL is user-supplied and we don't want to proxy it.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.logoUrl}
                alt="Company logo"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-caption text-text-tertiary">No logo</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleLogoUpload(f);
              }}
              disabled={!canEdit || logoBusy}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={logoBusy}
              disabled={!canEdit || logoBusy}
              onClick={() => fileRef.current?.click()}
            >
              <UploadCloud className="h-4 w-4" aria-hidden={true} />
              Upload new
            </Button>
            {data.logoUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canEdit || logoBusy}
                onClick={() => void handleLogoClear()}
              >
                <X className="h-4 w-4" aria-hidden={true} />
                Remove
              </Button>
            )}
          </div>
        </div>
        {logoError && (
          <p className="mt-2 text-body-sm text-semantic-error">{logoError}</p>
        )}
      </section>

      {/* Profile */}
      <section className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-1.5">
          <h2 className="text-h3 text-text-primary">Profile</h2>
          <p className="text-body-sm text-text-secondary">
            Company name appears on customer quote PDFs and vendor dispatch
            emails. Timezone pins all customer- and vendor-facing dates.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div>
            <Label htmlFor="company-name">Company name</Label>
            <Input
              id="company-name"
              value={data.name}
              maxLength={120}
              disabled={!canEdit}
              onChange={(e) =>
                setData((prev) => (prev ? { ...prev, name: e.target.value } : prev))
              }
            />
          </div>
          <div>
            <Label htmlFor="company-timezone">Timezone</Label>
            <SelectBox
              id="company-timezone"
              value={data.timezone}
              disabled={!canEdit}
              onChange={(value) =>
                setData((prev) => (prev ? { ...prev, timezone: value } : prev))
              }
            >
              {COMPANY_TIMEZONES.map((tz) => (
                <option key={tz.id} value={tz.id}>
                  {tz.label}  ({tz.offsetHint})
                </option>
              ))}
            </SelectBox>
          </div>
        </div>
      </section>

      {/* Consolidation default */}
      <section className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-1.5">
          <h2 className="text-h3 text-text-primary">Default consolidation mode</h2>
          <p className="text-body-sm text-text-secondary">
            Per-bid override still lives on the bid review screen — this just
            sets the starting mode for new bids.
          </p>
        </div>
        <SelectBox
          id="company-consolidation"
          value={data.defaultConsolidationMode}
          disabled={!canEdit}
          onChange={(value) =>
            setData((prev) =>
              prev ? { ...prev, defaultConsolidationMode: value as ConsolidationMode } : prev,
            )
          }
        >
          {CONSOLIDATION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label} — {m.hint}
            </option>
          ))}
        </SelectBox>
      </section>

      {/* Regions */}
      <section className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-1.5">
          <h2 className="text-h3 text-text-primary">Regions served</h2>
          <p className="text-body-sm text-text-secondary">
            Which US regions your company quotes into. Empty = serves
            everywhere. Used by the vendor dispatch shortlist.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {US_REGIONS.map((region) => {
            const checked = data.jobRegionsServed.includes(region.id);
            return (
              <label
                key={region.id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-sm border p-3 transition-colors duration-micro',
                  checked
                    ? 'border-accent-primary bg-[rgba(29,184,122,0.08)]'
                    : 'border-border-base bg-bg-elevated hover:bg-bg-subtle',
                  !canEdit && 'cursor-not-allowed opacity-70',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded-sm accent-accent-primary"
                  checked={checked}
                  disabled={!canEdit}
                  onChange={(e) => {
                    setData((prev) => {
                      if (!prev) return prev;
                      const next = new Set(prev.jobRegionsServed);
                      if (e.target.checked) next.add(region.id);
                      else next.delete(region.id);
                      return { ...prev, jobRegionsServed: Array.from(next) };
                    });
                  }}
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-body text-text-primary">{region.name}</span>
                  <span className="text-caption text-text-tertiary">
                    {region.states.join(', ')}
                  </span>
                </div>
              </label>
            );
          })}
        </div>
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

function SelectBox({
  id,
  value,
  disabled,
  onChange,
  children,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="block h-9 w-full rounded-sm border border-border-base bg-bg-subtle px-3 text-body text-text-primary transition-[background-color,border-color,box-shadow] duration-micro focus:border-accent-primary focus:bg-bg-elevated focus:shadow-accent focus:outline-none disabled:opacity-40"
    >
      {children}
    </select>
  );
}
