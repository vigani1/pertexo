import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('API development runner', () => {
  it('keeps Nest metadata on the TypeScript compile-and-watch path', () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const compilerConfig: unknown = JSON.parse(
      readFileSync(
        new URL('../../../tsconfig.base.json', import.meta.url),
        'utf8',
      ),
    );
    const runner = readFileSync(
      new URL('../scripts/dev.mjs', import.meta.url),
      'utf8',
    );

    expect(packageJson).toMatchObject({
      scripts: { dev: 'node scripts/dev.mjs' },
    });
    expect(compilerConfig).toMatchObject({
      compilerOptions: {
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
      },
    });
    expect(runner).toContain('typescript/bin/tsc');
    expect(runner).toContain("'--watch'");
    expect(runner).toContain("'dist/main.js'");
  });
});
