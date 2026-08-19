import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const packageSchema = z.object({
  browser: z.record(z.string(), z.literal(false)),
  exports: z.record(
    z.string(),
    z.object({
      default: z.string(),
      node: z.string(),
      types: z.string(),
    }),
  ),
});

describe('observability package contract', () => {
  it('marks every runtime export as unavailable to browser bundlers', async () => {
    const packageUrl = new URL('../package.json', import.meta.url);
    const packageJson = packageSchema.parse(
      JSON.parse(await readFile(packageUrl, 'utf8')),
    );

    for (const exported of Object.values(packageJson.exports)) {
      expect(exported.default).toBe(exported.node);
      expect(packageJson.browser[exported.node]).toBe(false);
    }
  });

  it('publishes transport metrics only through a server-only deep export', async () => {
    const packageUrl = new URL('../package.json', import.meta.url);
    const packageJson = packageSchema.parse(
      JSON.parse(await readFile(packageUrl, 'utf8')),
    );
    const exported = packageJson.exports['./transport-metrics'];

    expect(exported).toEqual({
      default: './dist/transport-metrics.js',
      node: './dist/transport-metrics.js',
      types: './dist/transport-metrics.d.ts',
    });
    expect(packageJson.browser['./dist/transport-metrics.js']).toBe(false);
  });
});
