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
import { Providers } from './providers';
import { THEME_BOOT_SCRIPT } from '../components/layout/theme-toggle';

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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F3EE' },
    { media: '(prefers-color-scheme: dark)', color: '#0A0A0A' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies stored dark/light theme before first paint. See
            components/layout/theme-toggle.tsx for the full flow. */}
        <script
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-screen bg-bg-base text-text-secondary font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
