import { defineConfig } from 'vitest/config';

/** Chromium-dependent harness proofs, owned by the installed-browser lane. */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['test/support/**/*.browser-probe.test.ts'],
    fileParallelism: false,
    allowOnly: false,
  },
});
