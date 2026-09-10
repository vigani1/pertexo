import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import * as browserEntry from '../src/index.js';
import * as releaseEntry from '../src/release.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

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

  it('keeps browser entries transitively free of Node/server modules', async () => {
    await expect(
      execFileAsync(process.execPath, [
        resolve(
          packageDirectory,
          '../../infrastructure/browser-entry-dependencies.mjs',
        ),
        '--root',
        resolve(packageDirectory, '../..'),
        'packages/node-sdk/src/index.ts',
        'packages/node-sdk/src/release.ts',
      ]),
    ).resolves.toMatchObject({ stderr: '' });
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
