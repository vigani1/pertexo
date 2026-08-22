import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as browserEntry from '../src/index.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('@pertexo/node-catalog package contract', () => {
  it('keeps browser release metadata separate from server registry composition', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
    ) as {
      readonly exports: Readonly<Record<string, unknown>>;
      readonly browser: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(packageJson.exports).sort()).toEqual(['.', './server']);
    expect(packageJson.browser['./dist/server.js']).toBe(false);
    expect(packageJson.browser['./dist/server-only.js']).toBe(false);
    expect(Object.keys(browserEntry)).not.toContain(
      'createPlatformNodeRegistryForRelease',
    );
    const indexSource = await readFile(
      resolve(packageDirectory, 'src/index.ts'),
      'utf8',
    );
    expect(indexSource).not.toMatch(/node:/u);
    expect(indexSource).not.toMatch(/\.\/server(?:\.js|['"])/u);
  });
});
