/**
 * Ingest queue worker — dedicated Node entry point.
 *
 * Purpose:  Drains the BullMQ `lmbr-extraction` queue. This file is NOT a
 *           Next.js route handler — it has no POST export, no route
 *           segment config, and should not be deployed to Vercel. Run it
 *           on a long-lived Node process (ECS task, Fly machine, systemd
 *           unit, Railway worker) with REDIS_URL set.
 *
 *           Usage:
 *             REDIS_URL=redis://… node apps/web/.next/server/ingest-worker.js
 *           — or during development:
 *             REDIS_URL=redis://localhost:6379 \
 *               pnpm --filter @lmbr/web exec tsx src/app/api/ingest/worker.ts
 *
 *           The worker imports the same processIngestJob as the inline
 *           route so there's exactly one pipeline. createIngestWorker()
 *           wires it to BullMQ with retry + dead-letter defaults; this
 *           file just glues the two together and handles SIGTERM for
 *           graceful shutdown.
 *
 * Agent/API: BullMQ + ioredis via @lmbr/lib.
 * Imports:  @lmbr/lib (createIngestWorker), ./processor.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { createIngestWorker } from '@lmbr/lib/queue';

import { processIngestJob } from './processor';

async function main(): Promise<void> {
  if (!process.env['REDIS_URL']) {
    console.error(
      '[ingest-worker] REDIS_URL is not set — inline mode is handled by the HTTP route, not this worker. Exiting.',
    );
    process.exit(1);
  }

  const worker = await createIngestWorker(processIngestJob);

  console.log('[ingest-worker] draining lmbr-extraction queue');

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[ingest-worker] ${signal} received — closing worker`);
    try {
      await worker.close();
    } catch (err) {
      console.error('[ingest-worker] shutdown error', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err) => {
  console.error('[ingest-worker] fatal', err);
  process.exit(1);
});
