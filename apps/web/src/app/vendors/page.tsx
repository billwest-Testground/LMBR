/**
 * Vendors index — distributor's supplier roster.
 *
 * Purpose:  Landing page for the vendor roster. Loads the tenant's active
 *           vendors via GET /api/vendors (Task 2) and renders them through
 *           VendorList. The header surfaces the total count and a
 *           "New vendor" link — vendor CRUD UI is a future task so the
 *           link is a visible placeholder; see the TODO below.
 * Inputs:   none.
 * Outputs:  JSX (client component).
 * Agent/API: GET /api/vendors.
 * Imports:  @lmbr/types (Vendor), lucide-react, VendorList, next/link.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';

import type { Vendor } from '@lmbr/types';

import { Button } from '../../components/ui/button';
import { VendorList } from '../../components/vendors/vendor-list';

export default function VendorsIndexPage() {
  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/vendors');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error ?? `Failed to load vendors (${res.status})`);
        }
        const data = (await res.json()) as { vendors: Vendor[] };
        if (cancelled) return;
        setVendors(data.vendors ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load vendors');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1 text-text-primary">Vendors</h1>
          <p className="mt-1 text-body text-text-secondary">
            {loading
              ? 'Loading…'
              : `${vendors.length} vendor${vendors.length === 1 ? '' : 's'} on file`}
          </p>
        </div>

        {/*
         * TODO(future-task): Wire "New vendor" to /vendors/new once the
         * vendor CRUD form exists. The dispatch flow (Prompt 05) does
         * not require vendor creation from the UI — we rely on seed
         * data and the POST /api/vendors route for now. Rendering as a
         * disabled button (rather than an anchor to a nonexistent
         * /vendors/new route) keeps next typedRoutes happy and signals
         * to the Buyer that the feature is upcoming.
         */}
        <Button disabled title="Vendor CRUD UI is a future task">
          <Plus className="h-4 w-4" aria-hidden="true" />
          New vendor
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-semantic-error/40 bg-[rgba(232,84,72,0.08)] p-4">
          <p className="text-body-sm text-semantic-error">{error}</p>
        </div>
      )}

      {!loading && !error && <VendorList vendors={vendors} />}

      {loading && (
        <div className="flex items-center justify-center rounded-md border border-border-base bg-bg-surface p-12">
          <p className="text-body-sm text-text-tertiary">Loading vendors…</p>
        </div>
      )}
    </div>
  );
}
