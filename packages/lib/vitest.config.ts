/**
 * Vitest config for @lmbr/lib.
 *
 * Purpose:  Node-environment unit tests for pure utilities in @lmbr/lib
 *           (pdf-quote builder, normalizers, etc.). Tests live under
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
