/**
 * Root layout for the LMBR.ai web console.
 *
 * Purpose:  The Next.js 14 app-router root layout. Wraps every page in the
 *           Trader / Buyer / Unified / Manager-Owner console, loads the
 *           global Tailwind stylesheet, and publishes the app metadata for
 *           SSR/HTML head.
 * Inputs:   `children` — any app-router page.
 * Outputs:  <html>/<body> scaffold.
 * Agent/API: none directly.
 * Imports:  ./globals.css, next/metadata types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'LMBR.ai — AI Bid Automation for Lumber Distributors',
    template: '%s — LMBR.ai',
  },
  description:
    'LMBR.ai is the enterprise AI bid automation platform for wholesale lumber distributors. Ingest, route, bid, consolidate, compare, margin, quote — built by Worklighter.',
  applicationName: 'LMBR.ai',
  authors: [{ name: 'Worklighter' }],
  creator: 'Worklighter',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-lmbr-paper text-lmbr-ink font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
