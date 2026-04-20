/**
 * Onboarding — Step 4 · Vendors.
 *
 * Purpose:  Captures the distributor's initial vendor list — mills,
 *           wholesalers, distributors, retailers — with the commodities
 *           they stock, the regions they service, and their minimum
 *           order threshold in MBF. Feeds the routing engine and the
 *           vendor selector UI on day one.
 *
 *           Client-side: uses the authenticated Supabase browser client
 *           to bulk insert rows into public.vendors. The owner's role
 *           satisfies the tenant RLS policy directly.
 *
 *           Skippable — vendors can also be added or bulk-imported later
 *           from /vendors.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';

import { getSupabaseBrowserClient } from '../../../../lib/supabase/browser';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../components/ui/card';
import { cn } from '../../../../lib/cn';

type VendorType = 'mill' | 'wholesaler' | 'distributor' | 'retailer';

const VENDOR_TYPE_OPTIONS: Array<{ value: VendorType; label: string }> = [
  { value: 'mill', label: 'Mill' },
  { value: 'wholesaler', label: 'Wholesaler' },
  { value: 'distributor', label: 'Distributor' },
  { value: 'retailer', label: 'Retailer' },
];

const COMMODITIES = [
  'SPF',
  'DF',
  'HF',
  'SYP',
  'Cedar',
  'LVL',
  'OSB',
  'Plywood',
  'Treated',
] as const;

const REGIONS = [
  'Pacific Northwest',
  'Inland West',
  'Rockies',
  'Southwest',
  'Midwest',
  'Northeast',
  'Southeast',
  'South Central',
] as const;

interface VendorRow {
  localId: string;
  name: string;
  email: string;
  vendorType: VendorType;
  commodities: string[];
  regions: string[];
  minOrderMbf: string;
}

function newRow(): VendorRow {
  return {
    localId: crypto.randomUUID(),
    name: '',
    email: '',
    vendorType: 'wholesaler',
    commodities: [],
    regions: [],
    minOrderMbf: '',
  };
}

export default function OnboardingVendorsPage() {
  const router = useRouter();
  const supabase = React.useMemo(() => getSupabaseBrowserClient(), []);
  const [rows, setRows] = React.useState<VendorRow[]>([newRow()]);
  const [companyId, setCompanyId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace('/login?next=/onboarding/vendors');
        return;
      }
      const { data: profile } = await supabase
        .from('users')
        .select('company_id')
        .eq('id', user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!profile?.company_id) {
        router.replace('/onboarding/company');
        return;
      }
      setCompanyId(profile.company_id);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  function update(id: string, patch: Partial<VendorRow>) {
    setRows((current) => current.map((r) => (r.localId === id ? { ...r, ...patch } : r)));
  }

  function toggleCommodity(id: string, commodity: string) {
    setRows((current) =>
      current.map((r) =>
        r.localId !== id
          ? r
          : {
              ...r,
              commodities: r.commodities.includes(commodity)
                ? r.commodities.filter((c) => c !== commodity)
                : [...r.commodities, commodity],
            },
      ),
    );
  }

  function toggleRegion(id: string, region: string) {
    setRows((current) =>
      current.map((r) =>
        r.localId !== id
          ? r
          : {
              ...r,
              regions: r.regions.includes(region)
                ? r.regions.filter((x) => x !== region)
                : [...r.regions, region],
            },
      ),
    );
  }

  function addRow() {
    setRows((current) => [...current, newRow()]);
  }

  function removeRow(id: string) {
    setRows((current) => (current.length === 1 ? current : current.filter((r) => r.localId !== id)));
  }

  async function handleFinish() {
    if (!companyId) return;

    const toInsert = rows
      .filter((r) => r.name.trim().length > 0)
      .map((r) => ({
        company_id: companyId,
        name: r.name.trim(),
        email: r.email.trim() || null,
        vendor_type: r.vendorType,
        commodities: r.commodities,
        regions: r.regions,
        min_order_mbf: r.minOrderMbf.trim().length > 0 ? Number(r.minOrderMbf) : 0,
        active: true,
      }));

    if (toInsert.length === 0) {
      router.push('/dashboard');
      router.refresh();
      return;
    }

    setLoading(true);
    setError(null);

    const { error: insertError } = await supabase.from('vendors').insert(toInsert);

    setLoading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    router.push('/dashboard');
    router.refresh();
  }

  function handleSkip() {
    router.push('/dashboard');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add your first vendors</CardTitle>
        <CardDescription>
          Mills, wholesalers, and distributors your buyers already work
          with. You can import a full CSV or bulk-add later from Vendors.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-5">
        {rows.map((row) => (
          <div
            key={row.localId}
            className="rounded-md border border-border-base bg-bg-subtle p-4"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <div>
                  <Label htmlFor={`v-name-${row.localId}`}>Vendor name</Label>
                  <Input
                    id={`v-name-${row.localId}`}
                    placeholder="Weyerhaeuser"
                    value={row.name}
                    onChange={(e) => update(row.localId, { name: e.target.value })}
                    disabled={loading}
                  />
                </div>
                <div>
                  <Label htmlFor={`v-email-${row.localId}`}>Contact email</Label>
                  <Input
                    id={`v-email-${row.localId}`}
                    type="email"
                    placeholder="sales@weyerhaeuser.com"
                    value={row.email}
                    onChange={(e) => update(row.localId, { email: e.target.value })}
                    disabled={loading}
                  />
                </div>
                <div>
                  <Label htmlFor={`v-type-${row.localId}`}>Type</Label>
                  <select
                    id={`v-type-${row.localId}`}
                    value={row.vendorType}
                    onChange={(e) =>
                      update(row.localId, { vendorType: e.target.value as VendorType })
                    }
                    disabled={loading}
                    className="block h-9 w-full rounded-sm border border-border-base bg-bg-subtle px-3 text-body text-text-primary focus:border-accent-primary focus:shadow-accent focus:outline-none"
                  >
                    {VENDOR_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor={`v-min-${row.localId}`}>Min order (MBF)</Label>
                  <Input
                    id={`v-min-${row.localId}`}
                    variant="price"
                    inputMode="decimal"
                    placeholder="0"
                    value={row.minOrderMbf}
                    onChange={(e) => update(row.localId, { minOrderMbf: e.target.value })}
                    disabled={loading}
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="icon"
                size="md"
                onClick={() => removeRow(row.localId)}
                disabled={rows.length === 1 || loading}
                aria-label="Remove vendor"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>

            <div className="mb-3">
              <Label>Commodities</Label>
              <div className="flex flex-wrap gap-2">
                {COMMODITIES.map((commodity) => {
                  const selected = row.commodities.includes(commodity);
                  return (
                    <button
                      key={commodity}
                      type="button"
                      onClick={() => toggleCommodity(row.localId, commodity)}
                      disabled={loading}
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-pill border px-3 text-caption uppercase tracking-wide transition-colors duration-micro',
                        selected
                          ? 'border-accent-primary bg-[rgba(29,184,122,0.12)] text-accent-primary'
                          : 'border-border-base text-text-tertiary hover:border-border-strong hover:text-text-secondary',
                      )}
                    >
                      {selected ? <X className="h-3 w-3" aria-hidden="true" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
                      {commodity}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label>Regions serviced</Label>
              <div className="flex flex-wrap gap-2">
                {REGIONS.map((region) => {
                  const selected = row.regions.includes(region);
                  return (
                    <button
                      key={region}
                      type="button"
                      onClick={() => toggleRegion(row.localId, region)}
                      disabled={loading}
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-pill border px-3 text-caption tracking-wide transition-colors duration-micro',
                        selected
                          ? 'border-accent-warm bg-[rgba(143,212,74,0.12)] text-accent-warm'
                          : 'border-border-base text-text-tertiary hover:border-border-strong hover:text-text-secondary',
                      )}
                    >
                      {region}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ))}

        <div>
          <Button type="button" variant="ghost" size="sm" onClick={addRow} disabled={loading}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add another vendor
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-sm border border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.10)] px-3 py-2 text-body-sm text-semantic-error"
        >
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-2 border-t border-border-subtle pt-5">
        <Button type="button" variant="ghost" onClick={handleSkip} disabled={loading}>
          Skip and finish
        </Button>
        <Button type="button" size="lg" onClick={handleFinish} loading={loading}>
          Finish setup and enter LMBR.ai
        </Button>
      </div>
    </Card>
  );
}
