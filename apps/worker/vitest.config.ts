import { defineConfig } from 'vitest/config';

import { workerResolve, workerTestDefaults } from './vitest.shared.config.js';

export default defineConfig({
  resolve: workerResolve,
  test: workerTestDefaults,
});
