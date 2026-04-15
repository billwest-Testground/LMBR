/**
 * Next.js configuration for the LMBR.ai web app.
 *
 * Purpose:  Wires the Next.js 14 app-router build for the LMBR.ai enterprise
 *           bid automation console. Transpiles the four `@lmbr/*` workspace
 *           packages so TypeScript sources are consumed directly without a
 *           pre-build step, and enables typed routes so every `<Link>` in
 *           the Trader / Buyer / Unified / Manager-Owner dashboards is
 *           checked at compile time.
 *
 *           Kept as `.mjs` because Next.js 14 does not support
 *           `next.config.ts` (TypeScript config support landed in Next 15).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
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
