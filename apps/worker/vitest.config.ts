import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@pertexo/queue': fileURLToPath(
        new URL('../../packages/queue/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
  },
});
