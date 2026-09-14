import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageDirectory, '../..');
const execFileAsync = promisify(execFile);

describe('contracts package boundary', () => {
  it('exposes deliberate browser-safe entry points without server dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      exports: Record<string, { default: string }>;
    };
    expect(manifest.dependencies).toHaveProperty(
      '@pertexo/workflow-model',
      'workspace:*',
    );
    expect(Object.keys(manifest.exports)).toEqual([
      './artifacts',
      '.',
      './errors',
      './connections',
      './catalog',
      './identity-workspace',
      './transport',
      './node-testing',
      './workflow-authoring',
      './workflow-runs',
      './webhooks',
      './schedules',
    ]);

    const repositoryRootUrl = new URL('../../../', import.meta.url);
    const applicationSources = [
      'apps/api/src/schedules/controllers.ts',
      'apps/api/src/webhooks/controllers.ts',
      'apps/api/src/workflow-authoring/types.ts',
      'apps/api/src/connections/failure-notification-destinations.ts',
      'apps/api/src/platform/observability/api-metrics.ts',
    ];
    for (const source of applicationSources) {
      expect(
        await readFile(new URL(source, repositoryRootUrl), 'utf8'),
      ).not.toMatch(/from ['"]@pertexo\/contracts['"]/u);
    }

    const entrySources = Object.values(manifest.exports).map((exported) =>
      exported.default
        .replace('./dist/', '../src/')
        .replace(/\.js$/u, '.ts')
        .replace(/^\.\.\/src\//u, 'packages/contracts/src/'),
    );
    await expect(
      execFileAsync(process.execPath, [
        resolve(
          repositoryRoot,
          'infrastructure/browser-entry-dependencies.mjs',
        ),
        '--root',
        repositoryRoot,
        ...entrySources,
      ]),
    ).resolves.toMatchObject({ stderr: '' });
    expect(
      await readFile(
        new URL('../src/http/workflow-authoring.ts', import.meta.url),
        'utf8',
      ),
    ).toContain("from '@pertexo/workflow-model/graph-contract'");
  });
});
