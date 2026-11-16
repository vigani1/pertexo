import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';
import { readFileSync } from 'node:fs';

const nodeTests = JSON.parse(
  readFileSync(new URL('./test/node-tests.json', import.meta.url), 'utf8'),
) as string[];

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Pure tests opt in explicitly; new files retain browser setup and isolation.
      projects: [
        {
          extends: true,
          test: { name: 'node', environment: 'node', include: nodeTests },
        },
        {
          extends: true,
          test: {
            name: 'browser',
            environment: 'jsdom',
            setupFiles: ['./test/setup.ts'],
            include: ['test/**/*.test.{ts,tsx}'],
            exclude: nodeTests,
          },
        },
      ],
      clearMocks: true,
      // Bound CPU-heavy full-app fixtures rather than oversubscribing local machines.
      maxWorkers: 4,
      // Page tests render the whole app and wait up to 3 s per step (see
      // test/setup.ts), plus up to 20 s for a lazy page's first load
      // (coldStart in test/support/fixtures/run.ts) on a busy machine.
      testTimeout: 30_000,
    },
  }),
);
