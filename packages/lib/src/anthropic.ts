/**
 * Anthropic client factory for LMBR.ai.
 *
 * Purpose:  Singleton Anthropic SDK instance used by every agent in
 *           @lmbr/agents and by any API route that calls Claude directly
 *           (ingest, extraction, QA, routing, pricing, comparison, market
 *           intel). Reads `ANTHROPIC_API_KEY` from the environment and
 *           centralizes default model + headers so upgrades happen in one
 *           place.
 *
 *           Model default is Sonnet 4.6 — the most capable Sonnet at the
 *           time of build. LMBR uses it for every agent (not Opus) so
 *           per-bid costs stay predictable for distributors paying
 *           $10k+/month; Opus gets pulled in selectively for the
 *           hardest extraction retries.
 *
 * Inputs:   process.env.ANTHROPIC_API_KEY.
 * Outputs:  `getAnthropic()` — memoized Anthropic client.
 * Agent/API: Anthropic Claude API.
 * Imports:  @anthropic-ai/sdk.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Default Claude model for every LMBR.ai agent (per CLAUDE.md). */
export const LMBR_DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Heavyweight fallback for extractions that the default model can't parse. */
export const LMBR_FALLBACK_MODEL = 'claude-opus-4-6';

let anthropicSingleton: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (anthropicSingleton) return anthropicSingleton;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      'LMBR.ai: missing ANTHROPIC_API_KEY environment variable. ' +
        'Set it in apps/web/.env.local (or the mobile runtime config).',
    );
  }
  anthropicSingleton = new Anthropic({
    apiKey,
    defaultHeaders: {
      'anthropic-beta': 'pdfs-2024-09-25',
    },
  });
  return anthropicSingleton;
}

export interface ClaudeCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
}
