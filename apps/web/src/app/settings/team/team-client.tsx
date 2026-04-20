/**
 * TeamClient — /settings/team interactive island.
 *
 * Purpose:  Two-section UI: an invite form at the top and a table of
 *           every teammate beneath. Pending invites are pinned to the
 *           top of the table. Role changes and deactivations POST to
 *           the narrow API routes and reload the roster.
 *
 *           Role descriptions are rendered inline next to each choice
 *           in the invite dropdown and below the role cell when a
 *           user is hovered / focused. Keeps the settings page
 *           self-documenting without a separate docs tab.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Loader2, Trash2, UserPlus } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { cn } from '../../../lib/cn';

type InvitableRole = 'trader' | 'buyer' | 'trader_buyer' | 'manager';

interface TeamMember {
  id: string;
  email: string;
  fullName: string | null;
  role: string | null;
  pending: boolean;
  lastSignInAt: string | null;
}

const ROLE_META: Record<string, { label: string; blurb: string }> = {
  owner: {
    label: 'Owner',
    blurb: 'Full admin. Billing, team, approvals, all bids. Cannot be invited.',
  },
  manager: {
    label: 'Manager',
    blurb: 'Approves quotes, manages team and settings. Sees all bids.',
  },
  trader_buyer: {
    label: 'Trader-Buyer',
    blurb: 'Unified trader + buyer workflow. Self-routes their own bids.',
  },
  trader: {
    label: 'Trader',
    blurb: 'Handles customer RFQs, margin, quote output. Private bid list.',
  },
  buyer: {
    label: 'Buyer',
    blurb: 'Manages vendor relationships and pricing extraction.',
  },
};

const INVITABLE: { value: InvitableRole; label: string; blurb: string }[] = [
  { value: 'trader',        label: 'Trader',        blurb: ROLE_META.trader!.blurb },
  { value: 'buyer',         label: 'Buyer',         blurb: ROLE_META.buyer!.blurb },
  { value: 'trader_buyer',  label: 'Trader-Buyer',  blurb: ROLE_META.trader_buyer!.blurb },
  { value: 'manager',       label: 'Manager',       blurb: ROLE_META.manager!.blurb },
];

export function TeamClient({
  canEdit,
  callerId,
}: {
  canEdit: boolean;
  callerId: string;
}) {
  const [members, setMembers] = React.useState<TeamMember[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = React.useState<string | null>(null);
  const [email, setEmail] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [roleType, setRoleType] = React.useState<InvitableRole>('trader');
  const [mutatingUserId, setMutatingUserId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/settings/team', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Load failed (${res.status})`);
      }
      const body = (await res.json()) as { members: TeamMember[] };
      setMembers(body.members);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Team load failed');
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setInviteBusy(true);
    setInviteError(null);
    setInviteSuccess(null);
    try {
      const res = await fetch('/api/settings/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, fullName, roleType }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Invite failed (${res.status})`);
      }
      setInviteSuccess(`Invite sent to ${email}.`);
      setEmail('');
      setFullName('');
      await load();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Invite failed');
    } finally {
      setInviteBusy(false);
    }
  }

  async function setMemberRole(userId: string, role: string | null) {
    setMutatingUserId(userId);
    try {
      const res = await fetch(`/api/settings/team/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Update failed (${res.status})`);
      }
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setMutatingUserId(null);
    }
  }

  async function cancelInvite(userId: string) {
    if (!confirm('Cancel this pending invite? The auth record is deleted.')) return;
    setMutatingUserId(userId);
    try {
      const res = await fetch(`/api/settings/team/${userId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Cancel failed (${res.status})`);
      }
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setMutatingUserId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Invite form */}
      {canEdit && (
        <section className="rounded-md border border-border-base bg-bg-surface p-5 shadow-sm">
          <div className="mb-4 flex flex-col gap-1.5">
            <h2 className="text-h3 text-text-primary">Invite a teammate</h2>
            <p className="text-body-sm text-text-secondary">
              Sends a magic-link invite to the email below. The invitee lands
              fully provisioned inside your tenant.
            </p>
          </div>
          <form onSubmit={handleInvite} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={inviteBusy}
                  required
                />
              </div>
              <div>
                <Label htmlFor="invite-name">Full name</Label>
                <Input
                  id="invite-name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  disabled={inviteBusy}
                  required
                />
              </div>
              <div>
                <Label htmlFor="invite-role">Role</Label>
                <select
                  id="invite-role"
                  value={roleType}
                  disabled={inviteBusy}
                  onChange={(e) => setRoleType(e.target.value as InvitableRole)}
                  className="block h-9 w-full rounded-sm border border-border-base bg-bg-subtle px-3 text-body text-text-primary focus:border-accent-primary focus:outline-none disabled:opacity-40"
                >
                  {INVITABLE.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-caption text-text-tertiary">
                  {INVITABLE.find((r) => r.value === roleType)?.blurb}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex gap-3">
                {inviteError && (
                  <p className="text-body-sm text-semantic-error">{inviteError}</p>
                )}
                {inviteSuccess && (
                  <p className="text-body-sm text-accent-primary">{inviteSuccess}</p>
                )}
              </div>
              <Button type="submit" loading={inviteBusy}>
                <UserPlus className="h-4 w-4" aria-hidden={true} />
                Send invite
              </Button>
            </div>
          </form>
        </section>
      )}

      {/* Roster */}
      <section className="rounded-md border border-border-base bg-bg-surface shadow-sm">
        <div className="border-b border-border-subtle p-5">
          <h2 className="text-h3 text-text-primary">Teammates</h2>
        </div>
        {loadError && (
          <div className="m-5 rounded-sm border border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.1)] p-3 text-body-sm text-semantic-error">
            {loadError}
          </div>
        )}
        {!members && !loadError && (
          <div className="flex items-center gap-2 p-5 text-body-sm text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden={true} />
            Loading…
          </div>
        )}
        {members && members.length === 0 && (
          <div className="p-5 text-body-sm text-text-tertiary">
            No teammates yet.
          </div>
        )}
        {members && members.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {members.map((m) => (
              <TeamRow
                key={m.id}
                member={m}
                isSelf={m.id === callerId}
                canEdit={canEdit}
                busy={mutatingUserId === m.id}
                onChangeRole={(role) => void setMemberRole(m.id, role)}
                onCancelInvite={() => void cancelInvite(m.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {!canEdit && (
        <div className="rounded-sm border border-border-base bg-bg-elevated p-3 text-body-sm text-text-tertiary">
          Read-only view. Manager or owner role required to invite, assign roles,
          or deactivate teammates.
        </div>
      )}
    </div>
  );
}

function TeamRow({
  member,
  isSelf,
  canEdit,
  busy,
  onChangeRole,
  onCancelInvite,
}: {
  member: TeamMember;
  isSelf: boolean;
  canEdit: boolean;
  busy: boolean;
  onChangeRole: (role: string | null) => void;
  onCancelInvite: () => void;
}) {
  const currentRoleMeta = member.role ? ROLE_META[member.role] : undefined;
  const deactivated = member.role === null;

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body text-text-primary">
            {member.fullName ?? member.email}
          </span>
          {member.pending && (
            <span className="inline-flex items-center rounded-full border border-[rgba(232,161,72,0.35)] bg-[rgba(232,161,72,0.14)] px-2 py-0.5 text-caption text-semantic-warning">
              Pending invite
            </span>
          )}
          {deactivated && (
            <span className="inline-flex items-center rounded-full border border-border-base bg-bg-elevated px-2 py-0.5 text-caption text-text-tertiary">
              Deactivated
            </span>
          )}
          {isSelf && (
            <span className="inline-flex items-center rounded-full border border-accent-primary bg-[rgba(29,184,122,0.08)] px-2 py-0.5 text-caption text-accent-primary">
              You
            </span>
          )}
        </div>
        <span className="text-body-sm text-text-tertiary">{member.email}</span>
        {currentRoleMeta && (
          <span className="text-caption text-text-tertiary">
            {currentRoleMeta.label} — {currentRoleMeta.blurb}
          </span>
        )}
      </div>
      <div className={cn('flex flex-wrap items-center gap-2', busy && 'opacity-60')}>
        {canEdit && !isSelf && !deactivated && (
          <select
            value={member.role ?? ''}
            disabled={busy || member.role === 'owner'}
            onChange={(e) => onChangeRole(e.target.value)}
            className="h-8 rounded-sm border border-border-base bg-bg-subtle px-2 text-body-sm text-text-primary focus:border-accent-primary focus:outline-none disabled:opacity-40"
          >
            {INVITABLE.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
            {member.role === 'owner' && (
              <option value="owner">Owner</option>
            )}
          </select>
        )}
        {canEdit && !isSelf && deactivated && !member.pending && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onChangeRole('trader')}
          >
            Reactivate as Trader
          </Button>
        )}
        {canEdit && !isSelf && !deactivated && member.role !== 'owner' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onChangeRole(null)}
          >
            Deactivate
          </Button>
        )}
        {canEdit && member.pending && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={onCancelInvite}
          >
            <Trash2 className="h-4 w-4" aria-hidden={true} />
            Cancel invite
          </Button>
        )}
      </div>
    </li>
  );
}
