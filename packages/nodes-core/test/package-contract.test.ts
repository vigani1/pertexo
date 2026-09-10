import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import * as browserEntry from '../src/index.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

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

  it('keeps the browser entry transitively free of Node/server modules', async () => {
    await expect(
      execFileAsync(process.execPath, [
        resolve(
          packageDirectory,
          '../../infrastructure/browser-entry-dependencies.mjs',
        ),
        '--root',
        resolve(packageDirectory, '../..'),
        'packages/nodes-core/src/index.ts',
      ]),
    ).resolves.toMatchObject({ stderr: '' });
  });

  // Registration removal is pinned here; validate.test.ts and
  // node-execution.test.ts exercise each registration's schemas and executor.
  it('publishes the complete supported definition identity inventory', () => {
    expect(
      browserEntry.CORE_NODE_DEFINITION_REGISTRATIONS.map(
        ({ manifest }) =>
          `${manifest.definition.key}@${String(manifest.definition.version)}`,
      ),
    ).toEqual([
      'core.schedule@1',
      'core.schedule@2',
      'core.schedule@3',
      'core.webhook@1',
      'core.wait@1',
      'core.foreach@1',
      'core.merge@1',
      'core.merge@2',
      'core.merge@3',
      'core.parallel@1',
      'core.parallel@2',
      'core.parallel@3',
      'core.switch@1',
      'core.condition@1',
      'core.manual@1',
      'core.set@1',
      'core.terminate@1',
      'core.validate@1',
    ]);
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
