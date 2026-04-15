/**
 * Next.js configuration for the LMBR.ai web app.
 *
 * Purpose:  Wires the Next.js 14 app-router build for the LMBR.ai enterprise
 *           bid automation console. Transpiles the four `@lmbr/*` workspace
 *           packages so TypeScript sources are consumed directly without a
 *           pre-build step, and enables typed routes so every `<Link>` in
 *           the Trader / Buyer / Unified / Manager-Owner dashboards is
 *           checked at compile time.
 * Inputs:   env vars surfaced through `next.config.ts`.
 * Outputs:  `NextConfig` default export.
 * Agent/API: none (build-time only).
 * Imports:  next types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@lmbr/agents', '@lmbr/types', '@lmbr/lib', '@lmbr/config'],
  experimental: {
    typedRoutes: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: '**.blob.core.windows.net' },
    ],
  },
};

export default nextConfig;
