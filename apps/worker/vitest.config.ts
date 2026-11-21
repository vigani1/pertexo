import { defineConfig } from 'vitest/config';

import { workerResolve, workerTestDefaults } from './vitest.shared.config.js';

const processTests = ['test/main-process.test.ts'];

export default defineConfig({
  resolve: workerResolve,
  test: {
    ...workerTestDefaults,
    projects: [
      {
        extends: true,
        test: { name: 'unit', exclude: processTests },
      },
      {
        extends: true,
        test: {
          name: 'process',
          include: processTests,
          // This file spawns the compiled app. Startup on a loaded runner and
          // three 5 s event waits can exceed the 5 s unit budget.
          testTimeout: 17_000,
        },
      },
    ],
  },
});
