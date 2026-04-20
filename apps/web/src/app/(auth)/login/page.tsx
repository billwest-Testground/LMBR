/**
 * Login page — LMBR.ai authentication entry.
 *
 * Purpose:  Single-screen sign-in, sign-up, and magic-link entry point for
 *           the LMBR.ai web console. Two modes toggle inline — "Sign in"
 *           (existing user) and "Create company account" (founding owner
 *           for a brand-new tenant). When the user types an email, we
 *           debounce a lookup against companies.email_domain and show a
 *           "Signing in to [Company Name]" hint so traders/buyers know
 *           they're landing on the right tenant.
 *
 *           Post-success routing:
 *             • Existing user → /dashboard (middleware will hop to
 *               /onboarding/company if their users row is still missing).
 *             • New signup    → /onboarding/company directly.
 *
 *           Invited users (pre-seeded public.users rows by the team-
 *           onboarding step) click their magic link in email, land here
 *           with an active session, and get redirected to /dashboard.
 *
 * Inputs:   form { email, password, fullName }, `next` query param.
 * Outputs:  JSX sign-in surface.
 * Agent/API: Supabase Auth + companies table.
 * Imports:  @supabase/auth-helpers-nextjs (via lib/supabase/browser),
 *           react, next/navigation, design-system primitives.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';

import { getSupabaseBrowserClient } from '../../../lib/supabase/browser';
import { extractEmailDomain } from '../../../lib/slugify';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { cn } from '../../../lib/cn';

type AuthMode = 'signin' | 'signup';

interface DetectedCompany {
  id: string;
  name: string;
  slug: string;
}

// useSearchParams() forces client-side bail-out during static
// prerender in Next 14 unless it's inside a Suspense boundary. We
// keep the real form in LoginPageInner and wrap it in the default
// export — the empty fallback is fine because the prerendered HTML
// only needs to exist; the actual interactive form hydrates on the
// client and reads searchParams there.
export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginPageInner />
    </React.Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = React.useMemo(() => getSupabaseBrowserClient(), []);

  const [mode, setMode] = React.useState<AuthMode>('signin');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [loading, setLoading] = React.useState<false | 'password' | 'magic'>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [detectedCompany, setDetectedCompany] = React.useState<DetectedCompany | null>(null);

  const next = searchParams?.get('next') ?? '/dashboard';

  // --- Company slug detection via email domain ----------------------------
  React.useEffect(() => {
    const domain = extractEmailDomain(email);
    if (!domain) {
      setDetectedCompany(null);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      const { data } = await supabase
        .from('companies')
        .select('id, name, slug')
        .eq('email_domain', domain)
        .eq('active', true)
        .maybeSingle();
      if (cancelled) return;
      setDetectedCompany((data as DetectedCompany | null) ?? null);
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [email, supabase]);

  // --- Submit handlers -----------------------------------------------------
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (mode === 'signin') {
      setLoading('password');
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      setLoading(false);
      if (signInError) {
        setError(signInError.message);
        return;
      }
      router.replace(next as Route);
      router.refresh();
      return;
    }

    // signup — founding account for a new company tenant
    if (fullName.trim().length < 2) {
      setError('Enter your full name.');
      return;
    }
    setLoading('password');
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: buildEmailRedirect('/onboarding/company'),
      },
    });
    setLoading(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    if (!data.session) {
      // Email confirmation flow — prompt the user to check their inbox.
      setNotice(
        'Check your email for a confirmation link. Once confirmed, you can finish setting up your company.',
      );
      return;
    }

    router.replace('/onboarding/company');
    router.refresh();
  }

  async function handleMagicLink() {
    setError(null);
    setNotice(null);
    if (!email) {
      setError('Enter your email above first.');
      return;
    }
    setLoading('magic');
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: buildEmailRedirect(next),
        shouldCreateUser: false,
      },
    });
    setLoading(false);
    if (otpError) {
      setError(otpError.message);
      return;
    }
    setNotice('Magic link sent. Check your email to sign in.');
  }

  // --- Render --------------------------------------------------------------
  const isSignup = mode === 'signup';
  const isLoadingPassword = loading === 'password';
  const isLoadingMagic = loading === 'magic';

  return (
    <div className="w-full max-w-[440px]">
      <div className="mb-8 text-center">
        <h1 className="text-h1 text-text-primary">
          {isSignup ? 'Create your company account' : 'Sign in to LMBR.ai'}
        </h1>
        <p className="mt-2 text-body text-text-secondary">
          {isSignup
            ? 'Set up the tenant for your distributorship — you\u2019ll become the first owner.'
            : 'Enterprise AI bid automation for wholesale lumber distributors.'}
        </p>
      </div>

      <div className="rounded-lg border border-border-base bg-bg-surface p-6 shadow-md sm:p-8">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          {isSignup && (
            <div>
              <Label htmlFor="full-name">Full name</Label>
              <Input
                id="full-name"
                autoComplete="name"
                placeholder="Alex Carter"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                disabled={!!loading}
              />
            </div>
          )}

          <div>
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@cascadelumber.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={!!loading}
            />
            {detectedCompany && !isSignup && (
              <div className="mt-2 flex items-center gap-2 text-caption text-text-tertiary">
                <span className="status-dot bg-accent-primary" aria-hidden="true" />
                <span>
                  Signing in to{' '}
                  <span className="text-text-primary">{detectedCompany.name}</span>
                </span>
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-end justify-between">
              <Label htmlFor="password" className="mb-0">
                Password
              </Label>
              {!isSignup && (
                <button
                  type="button"
                  onClick={handleMagicLink}
                  disabled={!!loading}
                  className={cn(
                    'text-caption text-accent-primary transition-colors duration-micro',
                    'hover:text-accent-glow disabled:opacity-40',
                  )}
                >
                  {isLoadingMagic ? 'Sending…' : 'Email me a magic link'}
                </button>
              )}
            </div>
            <Input
              id="password"
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              placeholder={isSignup ? 'At least 8 characters' : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={isSignup ? 8 : undefined}
              disabled={!!loading}
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2 text-body-sm text-semantic-error"
            >
              {error}
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="rounded-sm border border-[rgba(74,158,232,0.35)] bg-[rgba(74,158,232,0.10)] px-3 py-2 text-body-sm text-semantic-info"
            >
              {notice}
            </div>
          )}

          <Button type="submit" size="lg" loading={isLoadingPassword} className="mt-2">
            {isSignup ? 'Create account and continue' : 'Sign in'}
          </Button>
        </form>
      </div>

      <div className="mt-6 text-center text-body-sm text-text-tertiary">
        {isSignup ? (
          <>
            Already have an account?{' '}
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError(null);
                setNotice(null);
              }}
              className="text-accent-primary transition-colors duration-micro hover:text-accent-glow"
            >
              Sign in
            </button>
          </>
        ) : (
          <>
            New distributorship?{' '}
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setError(null);
                setNotice(null);
              }}
              className="text-accent-primary transition-colors duration-micro hover:text-accent-glow"
            >
              Create a company account
            </button>
          </>
        )}
      </div>

      <div className="mt-6 flex justify-center text-caption text-text-tertiary">
        <Link
          href="/"
          className="transition-colors duration-micro hover:text-text-secondary"
        >
          ← Back to home
        </Link>
      </div>
    </div>
  );
}

function buildEmailRedirect(path: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return `${window.location.origin}${path}`;
}
