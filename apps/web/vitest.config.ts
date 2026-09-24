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
      // test/setup.ts); a busy machine needs more than the 5 s default.
      testTimeout: 15_000,
    },
  }),
);
