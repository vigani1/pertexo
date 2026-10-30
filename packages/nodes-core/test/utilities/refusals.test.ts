import { describe, expect, it } from 'vitest';

import { createCoreNodeRegistry } from '../../src/server.js';

// A utility's refusal tells the user the limit it actually enforces.
const registry = createCoreNodeRegistry();
const run = (key: string, config: unknown, input: unknown) =>
  registry.execute({
    definition: { key: `core.${key}`, version: 1 },
    executor: { key: `core.${key}`, version: 1 },
    config,
    input,
    signal: new AbortController().signal,
  });

describe('utility refusals name the limits they enforce', () => {
  it('refuses a result over 256 KB and says so', async () => {
    // {"value":"…"} adds 12 bytes around the text.
    const fits = 262_144 - 12;
    await expect(
      run('text', { operation: 'uppercase' }, { value: 'a'.repeat(fits) }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    await expect(
      run('text', { operation: 'uppercase' }, { value: 'a'.repeat(fits + 1) }),
    ).rejects.toMatchObject({
      safeErrorCode: 'utility.result_too_large',
      errorSummary: expect.stringContaining(
        '256 KB, depth 64 and 10,000 members',
      ) as unknown,
    });
  });

  it('refuses a result list over 4,998 items and says so', async () => {
    const items = (count: number) => '<r>' + '<i/>'.repeat(count) + '</r>';
    await expect(
      run('xml', { operation: 'parse' }, { value: items(4_998) }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    await expect(
      run('xml', { operation: 'parse' }, { value: items(4_999) }),
    ).rejects.toMatchObject({
      safeErrorCode: 'utility.too_many_items',
      errorSummary: expect.stringContaining('4,998 items') as unknown,
    });
  });

  it('refuses an XML input list over 4,998 items and says so', async () => {
    const list = (count: number) => ({
      r: { i: Array.from({ length: count }, () => 1) },
    });
    await expect(
      run('xml', { operation: 'build' }, { value: list(4_998) }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    await expect(
      run('xml', { operation: 'build' }, { value: list(4_999) }),
    ).rejects.toMatchObject({
      safeErrorCode: 'utility.too_many_items',
      errorSummary: expect.stringContaining('4,998 items') as unknown,
    });
  });
});
