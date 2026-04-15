/**
 * Onboarding — Step 3 · Commodity assignments.
 *
 * Purpose:  For each buyer / trader_buyer teammate in the tenant, assigns
 *           the commodity types they handle and the regions they cover.
 *           This powers the routing engine later: when a bid's line items
 *           need to be dispatched, LMBR filters the tenant's buyers by
 *           (commodity, job_region) and picks the right owner automatically.
 *
 *           Client-side: reads roles via the authenticated Supabase browser
 *           client (RLS-backed) and inserts commodity_assignments rows
 *           directly. The owner has is_manager_or_owner() → true, so the
 *           mutate policy on commodity_assignments accepts the writes.
 *
 *           Skippable — commodity coverage can also be set from Settings
 *           once buyers join.
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
import { Label } from '../../../../components/ui/label';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../components/ui/card';
import { cn } from '../../../../lib/cn';

// Normalized commodity vocabulary from CLAUDE.md "Lumber Domain Knowledge".
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

// Broad US lumber regions. Refine later in Settings; spec keeps this light.
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

interface AssignableRole {
  roleId: string;
  userId: string;
  userFullName: string;
  userEmail: string;
  roleType: 'buyer' | 'trader_buyer';
  commodities: string[]; // commodity_type values already selected
  regions: string[];     // union of regions across this role's assignments
  saved: boolean;
}

export default function OnboardingCommoditiesPage() {
  const router = useRouter();
  const supabase = React.useMemo(() => getSupabaseBrowserClient(), []);
  const [roles, setRoles] = React.useState<AssignableRole[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace('/login?next=/onboarding/commodities');
        return;
      }

      const { data: roleRows, error: rolesErr } = await supabase
        .from('roles')
        .select('id, user_id, role_type')
        .in('role_type', ['buyer', 'trader_buyer']);

      if (cancelled) return;
      if (rolesErr) {
        setError(rolesErr.message);
        setRoles([]);
        return;
      }

      const rolesSafe = roleRows ?? [];
      if (rolesSafe.length === 0) {
        setRoles([]);
        return;
      }

      const userIds = rolesSafe.map((r) => r.user_id);
      const { data: userRows } = await supabase
        .from('users')
        .select('id, full_name, email')
        .in('id', userIds);

      const userMap = new Map<string, { full_name: string; email: string }>();
      (userRows ?? []).forEach((u) =>
        userMap.set(u.id, { full_name: u.full_name, email: u.email }),
      );

      setRoles(
        rolesSafe.map((r) => {
          const u = userMap.get(r.user_id);
          return {
            roleId: r.id,
            userId: r.user_id,
            userFullName: u?.full_name ?? 'Unknown',
            userEmail: u?.email ?? '',
            roleType: r.role_type as 'buyer' | 'trader_buyer',
            commodities: [],
            regions: [],
            saved: false,
          };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  function toggleCommodity(roleId: string, commodity: string) {
    setRoles((current) =>
      (current ?? []).map((r) =>
        r.roleId !== roleId
          ? r
          : {
              ...r,
              commodities: r.commodities.includes(commodity)
                ? r.commodities.filter((c) => c !== commodity)
                : [...r.commodities, commodity],
              saved: false,
            },
      ),
    );
  }

  function toggleRegion(roleId: string, region: string) {
    setRoles((current) =>
      (current ?? []).map((r) =>
        r.roleId !== roleId
          ? r
          : {
              ...r,
              regions: r.regions.includes(region)
                ? r.regions.filter((x) => x !== region)
                : [...r.regions, region],
              saved: false,
            },
      ),
    );
  }

  async function handleSave() {
    if (!roles || roles.length === 0) {
      router.push('/onboarding/vendors');
      return;
    }

    setLoading(true);
    setError(null);

    const payload = roles.flatMap((role) =>
      role.commodities.map((commodity) => ({
        role_id: role.roleId,
        commodity_type: commodity,
        regions: role.regions,
      })),
    );

    if (payload.length === 0) {
      setLoading(false);
      router.push('/onboarding/vendors');
      return;
    }

    const { error: insertError } = await supabase
      .from('commodity_assignments')
      .upsert(payload, { onConflict: 'role_id,commodity_type' });

    setLoading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    router.push('/onboarding/vendors');
    router.refresh();
  }

  function handleSkip() {
    router.push('/onboarding/vendors');
  }

  if (roles === null) {
    return <LoadingCard />;
  }

  if (roles.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No buyers to configure yet</CardTitle>
          <CardDescription>
            You haven&apos;t invited any buyers or trader-buyers in the
            previous step. You can assign commodity coverage later from
            Settings once your team joins.
          </CardDescription>
        </CardHeader>
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border-subtle pt-5">
          <Button type="button" variant="ghost" onClick={() => router.push('/onboarding/roles')}>
            ← Back to team
          </Button>
          <Button type="button" size="lg" onClick={() => router.push('/onboarding/vendors')}>
            Continue
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Commodity coverage</CardTitle>
        <CardDescription>
          Tag each buyer with the commodity types they handle and the
          regions they cover. LMBR uses this to auto-route line items to
          the correct person.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-5">
        {roles.map((role) => (
          <div
            key={role.roleId}
            className="rounded-md border border-border-base bg-bg-subtle p-4"
          >
            <div className="mb-3 flex items-baseline justify-between">
              <div>
                <div className="text-h4 text-text-primary">
                  {role.userFullName}
                </div>
                <div className="text-caption text-text-tertiary">
                  {role.userEmail} · {role.roleType === 'trader_buyer' ? 'Trader + Buyer' : 'Buyer'}
                </div>
              </div>
            </div>

            <div className="mb-4">
              <Label>Commodities</Label>
              <div className="flex flex-wrap gap-2">
                {COMMODITIES.map((commodity) => {
                  const selected = role.commodities.includes(commodity);
                  return (
                    <button
                      key={commodity}
                      type="button"
                      onClick={() => toggleCommodity(role.roleId, commodity)}
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
              <Label>Regions</Label>
              <div className="flex flex-wrap gap-2">
                {REGIONS.map((region) => {
                  const selected = role.regions.includes(region);
                  return (
                    <button
                      key={region}
                      type="button"
                      onClick={() => toggleRegion(role.roleId, region)}
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
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2 text-body-sm text-semantic-error"
        >
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-2 border-t border-border-subtle pt-5">
        <Button type="button" variant="ghost" onClick={handleSkip} disabled={loading}>
          Skip for now
        </Button>
        <Button type="button" size="lg" onClick={handleSave} loading={loading}>
          Save and continue
        </Button>
      </div>
    </Card>
  );
}

function LoadingCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Loading team…</CardTitle>
        <CardDescription>Fetching your buyers from the tenant.</CardDescription>
      </CardHeader>
      <div className="flex items-center gap-2 text-body-sm text-text-tertiary">
        <span className="loading-dots">
          <span />
          <span />
          <span />
        </span>
      </div>
    </Card>
  );
}
