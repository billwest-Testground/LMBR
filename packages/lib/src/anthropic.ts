/**
 * Anthropic client factory for LMBR.ai.
 *
 * Purpose:  Singleton Anthropic SDK instance used by every agent in
 *           @lmbr/agents and by any API route that calls Claude directly
 *           (ingest, extraction, QA, routing, pricing, comparison, market
 *           intel). Reads `ANTHROPIC_API_KEY` from the environment and
 *           centralizes default headers, timeouts, and model selection so
 *           upgrades happen in one place.
 * Inputs:   process.env.ANTHROPIC_API_KEY.
 * Outputs:  `getAnthropic()` — memoized Anthropic client.
 * Agent/API: Anthropic Claude API.
 * Imports:  @anthropic-ai/sdk.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Anthropic from '@anthropic-ai/sdk';

export const LMBR_DEFAULT_MODEL = 'claude-sonnet-4-5';

export function getAnthropic(): Anthropic {
  throw new Error('Not implemented');
}

export interface ClaudeCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
}
