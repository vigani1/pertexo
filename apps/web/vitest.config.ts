import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
      clearMocks: true,
      // Page tests render the whole app and wait up to 3 s per step (see
      // test/setup.ts), plus up to 20 s for a lazy page's first load
      // (coldStart in test/support/fixtures/run.ts) on a busy machine.
      testTimeout: 30_000,
    },
  }),
);
