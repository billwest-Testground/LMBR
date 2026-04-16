/**
 * Vitest config for @lmbr/agents.
 *
 * Purpose:  Node-environment unit tests with TypeScript paths resolved
 *           through the workspace root (so @lmbr/types imports in agent
 *           code resolve to the sibling package). Tests live under
 *           src/__tests__/.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
