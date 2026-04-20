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
    // Local-dev ngrok tunnel — Next's dev server warns on non-origin
    // Host headers without this. Covers the free ngrok subdomain shape
    // used for Outlook webhook testing; production is served directly
    // from NEXT_PUBLIC_APP_URL so this only affects `next dev`.
    allowedDevOrigins: ['*.ngrok-free.app', '*.ngrok.app', '*.ngrok.io'],
    // Externalize node_modules-level Node-only packages from Server
    // Component bundles. The webpack externals block below is the
    // belt-and-braces version covering modules reached through
    // `transpilePackages`.
    serverComponentsExternalPackages: [
      'bullmq',
      'ioredis',
      'pdf-parse',
      'mammoth',
      'exceljs',
      'csv-parse',
      '@azure/msal-node',
      '@azure/ai-form-recognizer',
      '@microsoft/microsoft-graph-client',
    ],
    // Tree-shake barrel imports from @lmbr/lib + @lmbr/agents. Without
    // this, `import { foo } from '@lmbr/lib'` pulls the whole barrel
    // graph (attachment-analyzer → pdf-parse, outlook → @azure/msal-
    // node, etc.) into the route's bundle even when the route only
    // needed `foo`. optimizePackageImports rewrites the import to the
    // specific file.
    optimizePackageImports: ['@lmbr/lib', '@lmbr/agents'],
  },
  // Node-only packages that webpack must not try to bundle. The
  // @lmbr/lib barrel re-exports wrappers around these (attachment-
  // analyzer → pdf-parse, outlook → @azure/msal-node +
  // @microsoft/microsoft-graph-client, ocr → @azure/ai-form-recognizer,
  // queue → bullmq + ioredis). Next's high-level
  // `serverComponentsExternalPackages` option does not catch these
  // when they enter the graph via a `transpilePackages` workspace —
  // webpack still bundles their sources and chokes on runtime
  // `require('fs' | 'net' | 'dns' | 'worker_threads')`. Treating them
  // as commonjs externals from the webpack layer lets the server
  // bundle reference them as Node require() calls instead of pulling
  // their internals into the chunk.
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externals must be in `commonjs <name>` form for webpack to emit
      // a `require('<name>')` at runtime instead of bundling the
      // module. An array of bare module names is not the same thing —
      // webpack would treat each string as a `var` external name,
      // which breaks for CommonJS packages. The entries below must be
      // re-listed whenever a new Node-only package enters @lmbr/lib.
      const nodeOnly = [
        'bullmq',
        'ioredis',
        'pdf-parse',
        'mammoth',
        'exceljs',
        'csv-parse',
        '@azure/msal-node',
        '@azure/ai-form-recognizer',
        '@microsoft/microsoft-graph-client',
      ];
      const externalMap = Object.fromEntries(
        nodeOnly.map((name) => [name, `commonjs ${name}`]),
      );
      config.externals = Array.isArray(config.externals)
        ? [...config.externals, externalMap]
        : [config.externals, externalMap];
    }
    return config;
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: '**.blob.core.windows.net' },
    ],
  },
};

export default nextConfig;
