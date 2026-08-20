import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('workflow-model package contract', () => {
  it('makes every export explicitly server-only', async () => {
    const json = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, { node: string; default: string }>;
      browser: Record<string, false>;
    };
    for (const value of Object.values(json.exports)) {
      expect(value.default).toBe(value.node);
      expect(json.browser[value.node]).toBe(false);
      const source = new URL(
        value.node.replace('./dist/', '../src/').replace(/\.js$/u, '.ts'),
        import.meta.url,
      );
      expect(await readFile(source, 'utf8')).toContain(
        "import './server-only.js';",
      );
    }
  });
});
