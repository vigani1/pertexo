import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/lifecycle-command',
      // This is the executable lifecycle risk cohort. The subprocess suite
      // proves real signals and exit status separately; child-process V8
      // counters are intentionally not presented as this unit report.
      include: [
        'src/config.ts',
        'src/main.ts',
        'src/readiness-marker.ts',
        'src/run.ts',
      ],
      thresholds: {
        branches: 90,
        functions: 70,
        lines: 94,
        statements: 90,
      },
    },
  },
});
