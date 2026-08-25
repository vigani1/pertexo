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
      '.',
      './errors',
      './connections',
      './identity-workspace',
      './node-testing',
      './workflow-authoring',
      './workflow-runs',
      './webhooks',
    ]);

    for (const source of [
      '../src/index.ts',
      '../src/connections.ts',
      '../src/http/connections.ts',
      '../src/errors/api-problem.ts',
      '../src/http/identity-workspace.ts',
      '../src/identity-workspace.ts',
      '../src/workflow-authoring.ts',
      '../src/http/workflow-authoring.ts',
    ]) {
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
