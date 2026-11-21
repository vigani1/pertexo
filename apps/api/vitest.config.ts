import { defineConfig } from 'vitest/config';

const processTests = ['test/main-process.test.ts'];

export default defineConfig({
  test: {
    environment: 'node',
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
          // a 10 s child deadline can exceed the 5 s unit budget.
          testTimeout: 11_000,
        },
      },
    ],
    exclude: [
      'dist/**',
      'node_modules/**',
      'test/**/*.integration.test.ts',
      'test/**/*.browser-probe.test.ts',
    ],
  },
});
