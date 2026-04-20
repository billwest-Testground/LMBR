/**
 * /settings/notifications — per-company notification toggles.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

import { getSupabaseRSCClient } from '../../../lib/supabase/server';

import { BackToSettingsLink } from '../back-to-settings';
import { NotificationsForm } from './notifications-form';

export const dynamic = 'force-dynamic';

export default async function SettingsNotificationsPage() {
  const supabase = getSupabaseRSCClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const [profileRes, rolesRes] = await Promise.all([
    supabase
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle(),
    supabase.from('roles').select('role_type').eq('user_id', session.user.id),
  ]);
  if (!profileRes.data?.company_id) redirect('/onboarding/company');
  const callerRoles = (rolesRes.data ?? []).map((r) => r.role_type as string);
  const canEdit =
    callerRoles.includes('manager') || callerRoles.includes('owner');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackToSettingsLink />
        <h1 className="text-h1 text-text-primary">Notifications</h1>
        <p className="text-body text-text-secondary">
          Email alerts at the tenant level. Per-user overrides ship later —
          today these toggles apply to every teammate in the company.
        </p>
      </div>

      <NotificationsForm canEdit={canEdit} />
    </div>
  );
}
