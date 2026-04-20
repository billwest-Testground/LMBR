/**
 * /settings/pricing — approval threshold, min margin, margin presets.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

import { getSupabaseRSCClient } from '../../../lib/supabase/server';

import { BackToSettingsLink } from '../back-to-settings';
import { PricingForm } from './pricing-form';

export const dynamic = 'force-dynamic';

export default async function SettingsPricingPage() {
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
        <h1 className="text-h1 text-text-primary">Pricing</h1>
        <p className="text-body text-text-secondary">
          Approval threshold, minimum blended margin, and the preset ladder
          surfaced on the margin-stack screen. These drive quote release
          gating and flag below-floor margins before a quote ships.
        </p>
      </div>

      <PricingForm canEdit={canEdit} />
    </div>
  );
}
