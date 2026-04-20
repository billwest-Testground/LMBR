/**
 * /vendor-submit/[token] — public layout shell.
 *
 * Purpose:  Minimal wordmark-only chrome for the public vendor submission
 *           page. Deliberately avoids the authenticated ConsoleShell (no
 *           sidebar, no user menu, no tenant branding beyond the wordmark)
 *           because:
 *             1. The vendor is not a logged-in user of the tenant.
 *             2. The only legitimate trust anchor on this URL is the
 *                LMBR.ai wordmark + the HTTPS origin + the company name
 *                rendered by the page itself.
 *           Typography + token colors match the rest of the app so vendors
 *           who land here from an email link see the same visual language
 *           as the rest of the platform.
 * Inputs:   children — the public page.
 * Outputs:  JSX shell.
 * Agent/API: none.
 * Imports:  next/link.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';

export default function VendorSubmitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col bg-bg-base text-text-secondary">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(29,184,122,0.08),transparent_60%)]"
      />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-8 sm:py-6">
        <Link
          href="/"
          className="flex items-center gap-3 text-text-primary transition-colors duration-micro hover:text-accent-primary"
          aria-label="LMBR.ai home"
        >
          <span
            aria-hidden="true"
            className="h-6 w-6 rounded-sm bg-accent-primary"
          />
          <span className="text-h4 tracking-tight">
            LMBR<span className="text-accent-primary">.ai</span>
          </span>
        </Link>

        <div className="text-label uppercase text-text-tertiary">
          Vendor submission
        </div>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-stretch px-4 pb-16 pt-4 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>

      <footer className="relative z-10 px-6 py-6 text-caption text-text-tertiary sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <span>LMBR.ai — AI bid automation for wholesale lumber distributors</span>
          <span>Powered by Worklighter</span>
        </div>
      </footer>
    </div>
  );
}
