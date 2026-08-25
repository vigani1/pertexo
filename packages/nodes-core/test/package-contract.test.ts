import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as browserEntry from '../src/index.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('@pertexo/nodes-core package contract', () => {
  it('publishes browser manifests at the root and an explicit server subpath', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
    ) as {
      readonly exports: Readonly<Record<string, unknown>>;
      readonly browser: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(packageJson.exports).sort()).toEqual(['.', './server']);
    const serverExport = packageJson.exports['./server'] as Readonly<
      Record<string, unknown>
    >;
    expect(Object.keys(serverExport)).toEqual(['types', 'browser', 'node']);
    expect(serverExport).toEqual({
      types: './dist/server.d.ts',
      browser: false,
      node: './dist/server.js',
    });
    expect(packageJson.browser['./dist/server.js']).toBe(false);
    expect(packageJson.browser['./dist/server-only.js']).toBe(false);
    expect(Object.keys(browserEntry)).not.toContain('createCoreNodeRegistry');
    expect(Object.keys(browserEntry)).not.toContain('coreManualExecutor');
  });

  it('keeps the browser entry free of server-only and host imports', async () => {
    const indexSource = await readFile(
      resolve(packageDirectory, 'src/index.ts'),
      'utf8',
    );
    expect(indexSource).not.toMatch(/node:/u);
    expect(indexSource).not.toMatch(/\.\/server(?:\.js|['"])/u);
    expect(indexSource).not.toMatch(/@pertexo\/workflow-model(?:\/|['"])/u);
  });

  it('keeps each core node behind definition, validation, and executor modules', async () => {
    for (const node of ['manual', 'schedule', 'set', 'terminate', 'webhook'])
      for (const file of ['definition.ts', 'executor.ts', 'validation.ts'])
        await expect(
          readFile(resolve(packageDirectory, 'src', node, file), 'utf8'),
        ).resolves.toBeTruthy();
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
    expect(serverSource).not.toMatch(/@nestjs|drizzle|bullmq|redis/u);
    expect(serverSource).not.toMatch(/@pertexo\/workflow-model/u);
  });
});
