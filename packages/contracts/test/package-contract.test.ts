import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

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
      './identity-workspace',
      './node-testing',
      './workflow-authoring',
      './workflow-runs',
      './webhooks',
      './schedules',
    ]);

    const repositoryRoot = new URL('../../../', import.meta.url);
    const applicationSources = [
      'apps/api/src/schedules/controllers.ts',
      'apps/api/src/webhooks/controllers.ts',
      'apps/api/src/workflow-authoring/types.ts',
      'apps/api/src/connections/failure-notification-destinations.ts',
      'apps/api/src/platform/observability/api-metrics.ts',
    ];
    for (const source of applicationSources) {
      expect(
        await readFile(new URL(source, repositoryRoot), 'utf8'),
      ).not.toMatch(/from ['"]@pertexo\/contracts['"]/u);
    }

    for (const exported of Object.values(manifest.exports)) {
      const source = exported.default
        .replace('./dist/', '../src/')
        .replace(/\.js$/u, '.ts');
      expect(
        await readFile(new URL(source, import.meta.url), 'utf8'),
      ).not.toMatch(/from ['"]node:/u);
    }
    expect(
      await readFile(
        new URL('../src/http/workflow-authoring.ts', import.meta.url),
        'utf8',
      ),
    ).toContain("from '@pertexo/workflow-model/graph-contract'");
  });
});
