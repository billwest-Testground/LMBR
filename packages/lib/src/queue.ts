/**
 * Queue — Redis-optional job dispatcher for the tiered ingest pipeline.
 *
 * Purpose:  The orchestrator never branches on "do I have Redis". It
 *           always calls `enqueueOrRun(job, processor)` and the queue
 *           module decides based on REDIS_URL. When Redis is available,
 *           jobs are handed to BullMQ for concurrent, retryable, dead-
 *           letterable processing. When it isn't — which is the default
 *           for local dev and Vercel serverless deployments — the
 *           processor runs inline in the request, preserving the
 *           original synchronous response path for the orchestrator.
 *
 *           This lets a single codebase cover two very different
 *           deployment topologies without scattering `if (REDIS_URL)`
 *           checks across the app:
 *
 *             • Vercel serverless: no persistent workers, REDIS_URL
 *               unset, orchestrator processes inline and responds 200
 *               with the full extraction report.
 *             • Dedicated worker machines: REDIS_URL set, the API route
 *               enqueues and returns 202, a long-running Node process
 *               imported from `./queue-worker` drains the queue.
 *
 * Retry policy (BullMQ path):
 *   - 3 attempts, exponential backoff starting at 2s.
 *   - Dead letter = leave the bid row at status='extraction_failed' with
 *     the error message in bids.notes. The job itself is not retried by
 *     BullMQ after the 3rd failure — the trader sees a failed bid and
 *     re-uploads.
 *
 * Concurrency:
 *   - Half the available CPUs, minimum 1. Extraction is I/O-bound
 *     (Anthropic + Azure + Supabase), so saturating cores is fine.
 *
 * Imports:  bullmq + ioredis (lazy-loaded — only when REDIS_URL is set).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import os from 'node:os';

import type { Queue, Worker } from 'bullmq';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface IngestJob {
  /** UUID of the bid row already written in status='extracting'. */
  bidId: string;
  /** Multitenant isolation key. */
  companyId: string;
  /** Supabase storage path to the raw upload (bucket/key). */
  filePath: string;
  /** MIME type detected at upload time. */
  mimeType: string;
  /** Original filename for user-facing messages. */
  filename: string;
}

export type IngestJobProcessor<R = void> = (job: IngestJob) => Promise<R>;

export type EnqueueMode = 'queued' | 'inline';

export interface EnqueueResult<R = void> {
  mode: EnqueueMode;
  jobId?: string;
  /** Present only in inline mode — the value returned by the processor. */
  inlineResult?: R;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const QUEUE_NAME = 'lmbr-extraction';
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 2_000;

function getRedisUrl(): string | undefined {
  const url = process.env['REDIS_URL'];
  return url && url.length > 0 ? url : undefined;
}

function computeConcurrency(): number {
  const cpus = os.cpus().length || 1;
  return Math.max(1, Math.floor(cpus / 2));
}

// -----------------------------------------------------------------------------
// Lazy-loaded queue singleton
// -----------------------------------------------------------------------------

let queueSingleton: Queue<IngestJob> | null = null;

async function getQueue(): Promise<Queue<IngestJob>> {
  if (queueSingleton) return queueSingleton;

  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    throw new Error(
      'queue: REDIS_URL is not set — cannot instantiate BullMQ queue.',
    );
  }

  // Dynamic import — bullmq pulls in ioredis + msgpackr which we don't
  // want at module-load time on Edge runtimes. This path only runs when
  // REDIS_URL is explicitly set, i.e. on a dedicated Node worker box.
  const { Queue: BullQueue } = await import('bullmq');

  queueSingleton = new BullQueue<IngestJob>(QUEUE_NAME, {
    connection: { url: redisUrl },
    defaultJobOptions: {
      attempts: DEFAULT_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: DEFAULT_BACKOFF_MS,
      },
      removeOnComplete: {
        // Keep the last 500 successful jobs for operational visibility.
        count: 500,
      },
      removeOnFail: {
        count: 1000,
      },
    },
  });

  return queueSingleton;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Dispatch an ingest job the cheapest way that works in the current
 * runtime. Returns the mode so the HTTP handler can decide whether to
 * respond 202 (queued) or 200 with the full extraction report (inline).
 *
 * - REDIS_URL set → enqueue in BullMQ, return `{ mode: 'queued', jobId }`.
 * - REDIS_URL unset → run `processor(job)` synchronously and return
 *   `{ mode: 'inline' }`.
 *
 * The processor function is the shared `processIngestJob()` defined in
 * the ingest route. Keeping it a function parameter means the queue
 * module doesn't have to know about extraction pipeline internals.
 */
export async function enqueueOrRun<R = void>(
  job: IngestJob,
  processor: IngestJobProcessor<R>,
): Promise<EnqueueResult<R>> {
  if (!getRedisUrl()) {
    // Inline path — just run the processor. Errors propagate so the
    // route handler can surface them as 5xx and mark the bid failed.
    const inlineResult = await processor(job);
    return { mode: 'inline', inlineResult };
  }

  const queue = await getQueue();
  const jobId = `${job.companyId}:${job.bidId}`;
  const added = await queue.add('process-ingest', job, {
    // Idempotent add — a retry from the HTTP client can't double-enqueue
    // the same bid because BullMQ dedupes on jobId.
    jobId,
  });

  return {
    mode: 'queued',
    jobId: added.id ?? jobId,
  };
}

// -----------------------------------------------------------------------------
// Worker factory
// -----------------------------------------------------------------------------

/**
 * Create a BullMQ worker that drains the lmbr-extraction queue. Called
 * from the dedicated worker entrypoint (apps/web/src/app/api/ingest/
 * worker.ts for the Node-server deployment). The caller owns the worker
 * lifecycle — this factory just wires it up with sensible defaults.
 *
 * Throws if REDIS_URL is not set — there is no inline-mode worker; the
 * whole point of the worker is to run on a different process from the
 * HTTP handler.
 */
export async function createIngestWorker<R = void>(
  processor: IngestJobProcessor<R>,
): Promise<Worker<IngestJob>> {
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    throw new Error(
      'createIngestWorker: REDIS_URL is required to run a queue worker.',
    );
  }

  const { Worker: BullWorker } = await import('bullmq');

  const worker = new BullWorker<IngestJob>(
    QUEUE_NAME,
    async (job) => {
      await processor(job.data);
    },
    {
      connection: { url: redisUrl },
      concurrency: computeConcurrency(),
    },
  );

  // Minimal operational logging — the orchestrator logs the meaningful
  // stuff. These are just process-level "the worker is alive" pings.
  worker.on('failed', (job, err) => {
    console.warn('[queue] job failed', {
      jobId: job?.id,
      bidId: job?.data?.bidId,
      attempt: job?.attemptsMade,
      error: err?.message,
    });
  });

  worker.on('error', (err) => {
    console.error('[queue] worker error', { error: err.message });
  });

  return worker;
}

// -----------------------------------------------------------------------------
// Test / dev helper — dispose the queue singleton so hot reload doesn't
// leak connections.
// -----------------------------------------------------------------------------

export async function closeQueue(): Promise<void> {
  if (!queueSingleton) return;
  try {
    await queueSingleton.close();
  } catch (err) {
    console.warn('[queue] close failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  queueSingleton = null;
}
