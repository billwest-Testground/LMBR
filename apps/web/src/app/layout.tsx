/**
 * Root layout for the LMBR.ai web console.
 *
 * Purpose:  The Next.js 14 app-router root layout. Wires Inter + JetBrains
 *           Mono via next/font/google (zero-FOUT, no @fontsource install),
 *           applies the dark-first design-system base on <html>/<body>,
 *           and publishes the app metadata.
 * Inputs:   `children` — any app-router page.
 * Outputs:  <html>/<body> scaffold.
 * Agent/API: none directly.
 * Imports:  next/font/google, ./globals.css.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

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
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  ),
  themeColor: '#0A0E0C',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-bg-base text-text-secondary font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
