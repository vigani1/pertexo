import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('worker development runner', () => {
  it('runs through the Nest compile-and-watch runner, not tsx', () => {
    // WorkerReadiness injects WorkerDrainState by type, which needs the
    // decorator metadata that only the TypeScript compiler emits.
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );

    expect(packageJson).toMatchObject({
      scripts: {
        dev: 'node ../../infrastructure/development/run-nest-dev.mjs',
        start: 'node dist/main.js',
      },
    });
  });
});
