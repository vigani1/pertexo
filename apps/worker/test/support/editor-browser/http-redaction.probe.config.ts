import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/support/editor-browser/http-redaction.probe.ts'],
    reporters: ['default'],
  },
});
