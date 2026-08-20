import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('@pertexo/workflow-engine package contract', () => {
  it('keeps production and testing entries server-only', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly exports: Readonly<
        Record<
          string,
          {
            readonly types: string;
            readonly browser: false;
            readonly node: string;
          }
        >
      >;
      readonly browser: Readonly<Record<string, false>>;
    };
    expect(packageJson.exports['.']).toEqual({
      types: './dist/index.d.ts',
      browser: false,
      node: './dist/index.js',
    });
    expect(packageJson.exports['./testing']).toEqual({
      types: './dist/testing.d.ts',
      browser: false,
      node: './dist/testing.js',
    });
    expect(packageJson.browser['./dist/index.js']).toBe(false);
    expect(packageJson.browser['./dist/testing.js']).toBe(false);
    expect(packageJson.browser['./dist/server-only.js']).toBe(false);

    for (const source of ['index.ts', 'testing.ts']) {
      const firstStatement = (
        await readFile(new URL(`../src/${source}`, import.meta.url), 'utf8')
      )
        .split('\n')
        .find((line) => line.trim().length > 0);
      expect(firstStatement).toBe("import './server-only.js';");
    }
  });
});
