import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const packageSchema = z.object({
  browser: z.record(z.string(), z.literal(false)),
  exports: z.record(
    z.string(),
    z.object({ node: z.string(), types: z.string(), default: z.string() }),
  ),
});

describe('queue package contract', () => {
  it('marks every runtime export as unavailable to browser bundlers', async () => {
    const raw = await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const packageJson = packageSchema.parse(JSON.parse(raw));

    expect(packageJson.exports['./consumer']).toBeDefined();
    for (const exported of Object.values(packageJson.exports)) {
      expect(exported.default).toBe(exported.node);
      expect(packageJson.browser[exported.node]).toBe(false);

      const sourceUrl = new URL(
        exported.node.replace('./dist/', '../src/').replace(/\.js$/u, '.ts'),
        import.meta.url,
      );
      expect(await readFile(sourceUrl, 'utf8')).toContain(
        "import './server-only.js';",
      );
    }
  });
});
