import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as browserEntry from '../src/index.js';
import * as releaseEntry from '../src/release.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('@pertexo/node-sdk package contract', () => {
  it('publishes only browser-safe default/release exports and an explicit server subpath', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
    ) as {
      readonly exports: Readonly<Record<string, unknown>>;
      readonly browser: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './release',
      './server',
    ]);
    expect(packageJson.browser['./dist/server.js']).toBe(false);
    expect(packageJson.browser['./dist/server-only.js']).toBe(false);
    expect(packageJson.exports['./server']).toEqual({
      types: './dist/server.d.ts',
      browser: false,
      node: './dist/server.js',
    });
    expect(Object.keys(browserEntry)).not.toContain('createNodeRegistry');
    expect(Object.keys(browserEntry).sort()).toEqual(
      Object.keys(releaseEntry).sort(),
    );
  });

  it('keeps browser entry transitive source imports free of Node/server modules', async () => {
    const indexSource = await readFile(
      resolve(packageDirectory, 'src/index.ts'),
      'utf8',
    );
    const releaseSource = await readFile(
      resolve(packageDirectory, 'src/release.ts'),
      'utf8',
    );
    expect(`${indexSource}\n${releaseSource}`).not.toMatch(/node:/u);
    expect(`${indexSource}\n${releaseSource}`).not.toMatch(
      /\.\/server(?:\.js|['"])/u,
    );
  });

  it('guards the server subpath before loading implementation code', async () => {
    const serverSource = await readFile(
      resolve(packageDirectory, 'src/server.ts'),
      'utf8',
    );
    const firstStatement = serverSource
      .split('\n')
      .find((line) => line.trim().length > 0);
    expect(firstStatement).toBe("import './server-only.js';");
    expect(serverSource).not.toMatch(
      /@nestjs|drizzle|bullmq|redis|@pertexo\/nodes-core/u,
    );
  });
});
