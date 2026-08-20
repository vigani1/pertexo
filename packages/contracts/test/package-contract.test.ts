import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('contracts package boundary', () => {
  it('exposes deliberate browser-safe entry points without server dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, { default: string }> };
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './errors',
      './identity-workspace',
      './workflow-authoring',
      './workflow-graph',
    ]);

    for (const source of [
      '../src/index.ts',
      '../src/errors/api-problem.ts',
      '../src/http/identity-workspace.ts',
      '../src/identity-workspace.ts',
      '../src/workflow-authoring.ts',
      '../src/http/workflow-authoring.ts',
      '../src/workflow-graph.ts',
    ]) {
      expect(
        await readFile(new URL(source, import.meta.url), 'utf8'),
      ).not.toMatch(/from ['"]node:/u);
    }
  });
});
