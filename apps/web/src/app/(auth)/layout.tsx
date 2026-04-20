/**
 * (auth) layout — shared chrome for /login and /onboarding.
 *
 * Purpose:  Centered dark-first shell with subtle brand gradient wash and
 *           the Worklighter wordmark in the corner. Applied to every
 *           unauthenticated-ish route — the login page, the 4-step
 *           onboarding wizard, password reset (future). Zero-decoration
 *           per README §14 rule 3 ("borders are structural not decorative").
 * Inputs:   `children` — any (auth) route.
 * Outputs:  JSX shell.
 * Agent/API: none.
 * Imports:  next/link, lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col bg-bg-base text-text-secondary">
      {/* Brand gradient wash — sits behind content, no visual noise. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(29,184,122,0.10),transparent_60%)]"
      />

      <header className="relative z-10 flex items-center justify-between px-8 py-6">
        <Link
          href="/"
          className="flex items-center gap-3 text-text-primary transition-colors duration-micro hover:text-accent-primary"
          aria-label="LMBR.ai home"
        >
          <span
            aria-hidden="true"
            className="h-6 w-6 rounded-sm bg-accent-primary"
          />
          <span className="text-h4 tracking-tight">LMBR<span className="text-accent-primary">.ai</span></span>
        </Link>

        <div className="text-label uppercase text-text-tertiary">
          Powered by Worklighter
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-start justify-center px-6 pb-20 pt-6 sm:items-center">
        {children}
      </main>

      <footer className="relative z-10 px-8 py-6 text-caption text-text-tertiary">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <span>LMBR.ai — AI bid automation for wholesale lumber distributors</span>
          <span>lmbr.ai · worklighter.ai</span>
        </div>
      </footer>
    </div>
  );
}
