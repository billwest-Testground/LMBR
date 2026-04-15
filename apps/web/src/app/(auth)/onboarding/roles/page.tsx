/**
 * Onboarding — Step 2 · Team + Roles.
 *
 * Purpose:  Lets the founding owner invite teammates by email and assign
 *           each one a role (trader, buyer, trader_buyer, manager) before
 *           they ever log in. Each invite hits POST /api/onboarding/invite,
 *           which sends a Supabase magic link AND pre-seeds the invitee's
 *           public.users + public.roles rows so they land in a fully
 *           provisioned tenant on first sign-in — no second hop back
 *           through onboarding.
 *
 *           Skippable: the owner can finish onboarding now and invite
 *           teammates later from Settings.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { X, UserPlus } from 'lucide-react';

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

type InviteRoleType = 'trader' | 'buyer' | 'trader_buyer' | 'manager';

interface InviteRow {
  localId: string;
  email: string;
  fullName: string;
  roleType: InviteRoleType;
  status: 'pending' | 'sending' | 'sent' | 'error';
  errorMessage?: string;
}

const ROLE_OPTIONS: Array<{ value: InviteRoleType; label: string; description: string }> = [
  { value: 'trader', label: 'Trader', description: 'Owns customer bids' },
  { value: 'buyer', label: 'Buyer', description: 'Dispatches vendors' },
  { value: 'trader_buyer', label: 'Trader + Buyer', description: 'Unified dashboard' },
  { value: 'manager', label: 'Manager', description: 'Approves + oversight' },
];

function newRow(): InviteRow {
  return {
    localId: crypto.randomUUID(),
    email: '',
    fullName: '',
    roleType: 'trader',
    status: 'pending',
  };
}

export default function OnboardingRolesPage() {
  const router = useRouter();
  const [rows, setRows] = React.useState<InviteRow[]>([newRow()]);
  const [loading, setLoading] = React.useState(false);

  function updateRow(id: string, patch: Partial<InviteRow>) {
    setRows((current) => current.map((r) => (r.localId === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((current) => [...current, newRow()]);
  }

  function removeRow(id: string) {
    setRows((current) => (current.length === 1 ? current : current.filter((r) => r.localId !== id)));
  }

  async function handleSendAll() {
    const toSend = rows.filter(
      (r) => r.status !== 'sent' && r.email.trim().length > 0 && r.fullName.trim().length > 0,
    );
    if (toSend.length === 0) {
      router.push('/onboarding/commodities');
      return;
    }

    setLoading(true);
    let anyFailed = false;

    for (const row of toSend) {
      updateRow(row.localId, { status: 'sending', errorMessage: undefined });
      const res = await fetch('/api/onboarding/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: row.email.trim(),
          fullName: row.fullName.trim(),
          roleType: row.roleType,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        anyFailed = true;
        updateRow(row.localId, {
          status: 'error',
          errorMessage: body.error ?? 'Invite failed',
        });
      } else {
        updateRow(row.localId, { status: 'sent', errorMessage: undefined });
      }
    }

    setLoading(false);

    if (!anyFailed) {
      router.push('/onboarding/commodities');
      router.refresh();
    }
  }

  function handleSkip() {
    router.push('/onboarding/commodities');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite your team</CardTitle>
        <CardDescription>
          Each teammate receives a magic-link email and lands in LMBR.ai with
          their role already assigned. Skippable — you can always add more
          people later from Settings.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-4">
        {rows.map((row) => {
          const isLocked = row.status === 'sending' || row.status === 'sent';
          return (
            <div
              key={row.localId}
              className={cn(
                'grid grid-cols-1 items-start gap-3 rounded-sm border border-border-base bg-bg-subtle p-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_auto]',
                row.status === 'sent' && 'border-[rgba(29,184,122,0.35)] bg-gradient-accent',
                row.status === 'error' && 'border-[rgba(232,84,72,0.45)]',
              )}
            >
              <div>
                <Label htmlFor={`name-${row.localId}`}>Name</Label>
                <Input
                  id={`name-${row.localId}`}
                  placeholder="Full name"
                  value={row.fullName}
                  onChange={(e) => updateRow(row.localId, { fullName: e.target.value })}
                  disabled={isLocked || loading}
                />
              </div>
              <div>
                <Label htmlFor={`email-${row.localId}`}>Email</Label>
                <Input
                  id={`email-${row.localId}`}
                  type="email"
                  placeholder="name@cascadelumber.com"
                  value={row.email}
                  onChange={(e) => updateRow(row.localId, { email: e.target.value })}
                  disabled={isLocked || loading}
                />
              </div>
              <div>
                <Label htmlFor={`role-${row.localId}`}>Role</Label>
                <select
                  id={`role-${row.localId}`}
                  value={row.roleType}
                  onChange={(e) =>
                    updateRow(row.localId, { roleType: e.target.value as InviteRoleType })
                  }
                  disabled={isLocked || loading}
                  className="block h-9 w-full rounded-sm border border-border-base bg-bg-subtle px-3 text-body text-text-primary focus:border-accent-primary focus:shadow-accent focus:outline-none"
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} — {opt.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end justify-end pb-0.5">
                <Button
                  type="button"
                  variant="icon"
                  size="md"
                  onClick={() => removeRow(row.localId)}
                  disabled={rows.length === 1 || isLocked || loading}
                  aria-label="Remove invite"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
              {row.status === 'sent' && (
                <div className="md:col-span-4 text-caption text-accent-primary">
                  Invite sent to {row.email}
                </div>
              )}
              {row.status === 'error' && row.errorMessage && (
                <div className="md:col-span-4 text-caption text-semantic-error">
                  {row.errorMessage}
                </div>
              )}
            </div>
          );
        })}

        <div>
          <Button type="button" variant="ghost" size="sm" onClick={addRow} disabled={loading}>
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Add another
          </Button>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between gap-2 border-t border-border-subtle pt-5">
        <Button type="button" variant="ghost" onClick={handleSkip} disabled={loading}>
          Skip for now
        </Button>
        <Button type="button" size="lg" onClick={handleSendAll} loading={loading}>
          Send invites and continue
        </Button>
      </div>
    </Card>
  );
}
