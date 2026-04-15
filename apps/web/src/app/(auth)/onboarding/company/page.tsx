/**
 * Onboarding — Step 1 · Company.
 *
 * Purpose:  Collects the four fields needed to provision the tenant row:
 *           company name, company slug (auto-derived from name, editable),
 *           email domain (auto-derived from the signed-in email, editable),
 *           and bids@ email prefix. POSTs to /api/onboarding/company which
 *           creates the companies row, the user's public.users row, and
 *           their owner role inside a single service-role transaction.
 *
 *           On success → /onboarding/roles (step 2). On 409 (already
 *           provisioned) → /dashboard. This step is the only one that is
 *           NOT skippable: a tenant must exist before steps 2–4 can run.
 *
 * Inputs:   form state (client).
 * Outputs:  JSX.
 * Agent/API: Supabase Auth session + /api/onboarding/company.
 * Imports:  Supabase browser client, UI primitives.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { getSupabaseBrowserClient } from '../../../../lib/supabase/browser';
import { slugify, extractEmailDomain } from '../../../../lib/slugify';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../components/ui/card';

export default function OnboardingCompanyPage() {
  const router = useRouter();
  const supabase = React.useMemo(() => getSupabaseBrowserClient(), []);

  const [sessionEmail, setSessionEmail] = React.useState<string | null>(null);
  const [companyName, setCompanyName] = React.useState('');
  const [companySlug, setCompanySlug] = React.useState('');
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [emailDomain, setEmailDomain] = React.useState('');
  const [bidsPrefix, setBidsPrefix] = React.useState('bids');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Pull the signed-in email so we can auto-suggest emailDomain.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) {
        router.replace('/login?next=/onboarding/company');
        return;
      }
      setSessionEmail(user.email ?? null);
      if (user.email) {
        const domain = extractEmailDomain(user.email);
        if (domain) setEmailDomain(domain);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  // Auto-derive slug from the company name until the user edits it manually.
  React.useEffect(() => {
    if (slugTouched) return;
    setCompanySlug(slugify(companyName));
  }, [companyName, slugTouched]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (companyName.trim().length < 2) {
      setError('Company name is required.');
      return;
    }
    if (companySlug.trim().length < 2) {
      setError('Company slug is required.');
      return;
    }

    setLoading(true);
    const res = await fetch('/api/onboarding/company', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyName: companyName.trim(),
        companySlug: companySlug.trim(),
        emailDomain: emailDomain.trim() || undefined,
        bidsPrefix: bidsPrefix.trim() || 'bids',
      }),
    });
    setLoading(false);

    if (res.status === 409) {
      router.replace('/dashboard');
      router.refresh();
      return;
    }

    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      company_id?: string;
    };

    if (!res.ok) {
      setError(body.error ?? 'Something went wrong. Try again.');
      return;
    }

    router.push('/onboarding/roles');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up your company</CardTitle>
        <CardDescription>
          Provisions your LMBR.ai tenant. You become the first owner —
          everything else (team, commodities, vendors) can be added in the
          next steps or later from Settings.
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <div>
          <Label htmlFor="company-name">Company name</Label>
          <Input
            id="company-name"
            placeholder="Cascade Lumber Co."
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            required
            disabled={loading}
          />
        </div>

        <div>
          <Label htmlFor="company-slug">Company slug</Label>
          <Input
            id="company-slug"
            placeholder="cascade-lumber"
            value={companySlug}
            onChange={(e) => {
              setSlugTouched(true);
              setCompanySlug(slugify(e.target.value));
            }}
            required
            disabled={loading}
          />
          <p className="mt-1 text-caption text-text-tertiary">
            Short URL-safe identifier. Used in deep links and team invites.
          </p>
        </div>

        <div>
          <Label htmlFor="email-domain">Email domain</Label>
          <Input
            id="email-domain"
            placeholder="cascadelumber.com"
            value={emailDomain}
            onChange={(e) => setEmailDomain(e.target.value.toLowerCase())}
            disabled={loading}
          />
          <p className="mt-1 text-caption text-text-tertiary">
            {sessionEmail
              ? `Detected from your sign-in address (${sessionEmail}). Change if different.`
              : 'LMBR uses this to route incoming RFQ emails to your tenant.'}
          </p>
        </div>

        <div>
          <Label htmlFor="bids-prefix">bids@ email prefix</Label>
          <div className="flex items-stretch gap-0">
            <Input
              id="bids-prefix"
              placeholder="bids"
              value={bidsPrefix}
              onChange={(e) => setBidsPrefix(e.target.value.toLowerCase())}
              disabled={loading}
              className="rounded-r-none"
            />
            <span className="inline-flex items-center rounded-r-sm border border-l-0 border-border-base bg-bg-subtle px-3 text-body text-text-tertiary">
              @{emailDomain || 'yourdomain.com'}
            </span>
          </div>
          <p className="mt-1 text-caption text-text-tertiary">
            Where customers forward RFQs. LMBR ingests everything that lands here.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2 text-body-sm text-semantic-error"
          >
            {error}
          </div>
        )}

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button type="submit" size="lg" loading={loading}>
            Continue
          </Button>
        </div>
      </form>
    </Card>
  );
}
