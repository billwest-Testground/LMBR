/**
 * VendorList — tenant-wide vendor roster display.
 *
 * Purpose:  Rendered on the /vendors index page. Shows every vendor the
 *           tenant has on file: name, type, region tags, commodity tags,
 *           min-order threshold, and active status. Intentionally
 *           read-only — vendor CRUD forms (new/edit/delete) are a
 *           later task, not part of Prompt 05.
 *
 *           Keeps to the Task 6 status-board's visual vocabulary so the
 *           two surfaces feel like the same product: bg-bg-surface tiles
 *           with border-border-base, type-specific pills for the region
 *           and commodity tags, and the inactive row rendered at reduced
 *           opacity rather than hidden outright (the backend GET already
 *           filters to `active = true`, but we keep the render robust
 *           should that change).
 *
 * Inputs:   { vendors: Vendor[] }.
 * Outputs:  JSX — grid of vendor rows.
 * Agent/API: none.
 * Imports:  @lmbr/types (Vendor), lucide-react.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import { CheckCircle2, MapPin, MinusCircle } from 'lucide-react';

import type { Vendor } from '@lmbr/types';

import { cn } from '../../lib/cn';

export interface VendorListProps {
  vendors: Vendor[];
}

export function VendorList({ vendors }: VendorListProps) {
  if (vendors.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border-base bg-bg-surface p-12 text-center">
        <h2 className="text-h3 text-text-primary">No vendors yet</h2>
        <p className="mt-1 text-body-sm text-text-secondary">
          Add a supplier to your roster to start dispatching bids to them.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {vendors.map((vendor) => (
        <VendorRow key={vendor.id} vendor={vendor} />
      ))}
    </div>
  );
}

function VendorRow({ vendor }: { vendor: Vendor }) {
  return (
    <div
      className={cn(
        'rounded-md border border-border-base bg-bg-surface p-4 shadow-sm',
        !vendor.active && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Identity */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h4 text-text-primary">{vendor.name}</h3>
            <span className="rounded-pill border border-border-base bg-bg-elevated px-2 py-0.5 text-caption uppercase tracking-wider text-text-secondary">
              {vendor.vendorType}
            </span>
            {vendor.active ? (
              <span className="inline-flex items-center gap-1 text-caption text-accent-primary">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                active
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-caption text-text-tertiary">
                <MinusCircle className="h-3 w-3" aria-hidden="true" />
                inactive
              </span>
            )}
          </div>
          {(vendor.contactName || vendor.email) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-tertiary">
              {vendor.contactName && <span>{vendor.contactName}</span>}
              {vendor.email && <span>{vendor.email}</span>}
            </div>
          )}
        </div>

        {/* Min order */}
        <div className="shrink-0 text-right">
          <p className="text-label uppercase tracking-wider text-text-tertiary">
            Min order
          </p>
          <p className="mt-1 font-mono text-body tabular-nums text-text-primary">
            {vendor.minOrderMbf > 0 ? `${vendor.minOrderMbf} MBF` : 'none'}
          </p>
        </div>
      </div>

      {/* Tags row */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <MapPin className="h-3 w-3 text-text-tertiary" aria-hidden="true" />
          {vendor.regions.length === 0 ? (
            <span className="text-caption text-text-tertiary">all regions</span>
          ) : (
            vendor.regions.map((r) => (
              <span
                key={r}
                className="rounded-pill bg-bg-elevated px-2 py-0.5 text-caption text-text-secondary"
              >
                {r}
              </span>
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {vendor.commodities.length === 0 ? (
            <span className="text-caption text-text-tertiary">no commodities</span>
          ) : (
            vendor.commodities.map((c) => (
              <span
                key={c}
                className="rounded-pill border border-accent-primary/30 bg-[rgba(29,184,122,0.08)] px-2 py-0.5 text-caption text-accent-primary"
              >
                {c}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
