import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('integration package exports', () => {
  it('keeps KMS and credential code behind the server-only export', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
      browser: Record<string, unknown>;
    };
    expect(packageJson.exports['./server']).toEqual(
      expect.objectContaining({ browser: false }),
    );
    expect(packageJson.browser['./dist/server.js']).toBe(false);
    expect(packageJson.browser['./dist/server-only.js']).toBe(false);
  });
});
