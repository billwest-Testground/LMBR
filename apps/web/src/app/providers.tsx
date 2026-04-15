/**
 * Providers — TanStack Query + global client-side context wrappers.
 *
 * Purpose:  Hosts any provider that must run inside the React client
 *           boundary. Right now this is TanStack Query for dashboard
 *           polling + optimistic cache, but it's also the natural home
 *           for a future ThemeProvider, a toast portal, or a Supabase
 *           realtime bridge. Rendered from the root layout so every
 *           page inherits it.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Dashboard polling: refetch every 10s by default so the
        // trader sees routing/bid state move in near-real-time without
        // having to set up Supabase realtime subscriptions on day one.
        refetchInterval: 10_000,
        refetchOnWindowFocus: true,
        staleTime: 5_000,
        retry: 1,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
