import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createCoreNodeRegistry } from '../src/server.js';
const registry = createCoreNodeRegistry();
const run = (operation: string, value: unknown) =>
  registry.execute({
    definition: { key: 'core.date', version: 1 },
    executor: { key: 'core.date', version: 1 },
    config: { operation },
    input: { value },
    signal: new AbortController().signal,
  });
describe('explicit date conversion', () => {
  it.each([
    [0, '1970-01-01T00:00:00.000Z'],
    [-1, '1969-12-31T23:59:59.999Z'],
    [-62_167_219_200_000, '0000-01-01T00:00:00.000Z'],
    [253_402_300_799_999, '9999-12-31T23:59:59.999Z'],
  ])('round-trips the integer instant %i', async (millis, iso) => {
    expect(await run('to_iso', millis)).toEqual({
      kind: 'succeeded',
      output: { value: iso },
    });
    expect(await run('to_epoch_millis', iso)).toEqual({
      kind: 'succeeded',
      output: { value: millis },
    });
  });
  it.each(['Z', '+00:00', '-00:00'])(
    'converts a known UTC instant using %s without inferring a local zone',
    async (offset) => {
      expect(
        await run('to_epoch_millis', `1970-01-01T00:00:00${offset}`),
      ).toMatchObject({ output: { value: 0 } });
    },
  );
  it('accepts explicit offsets through DST folds/gaps and millisecond fractions', async () => {
    expect(
      await run('to_epoch_millis', '1970-01-01T05:30:00.1+05:30'),
    ).toMatchObject({ output: { value: 100 } });
    expect(
      await run('to_epoch_millis', '1970-01-01T00:00:00.01Z'),
    ).toMatchObject({ output: { value: 10 } });
    const first = await run('to_epoch_millis', '2026-10-25T02:30:00+02:00');
    const second = await run('to_epoch_millis', '2026-10-25T02:30:00+01:00');
    expect(first).toMatchObject({
      output: { value: Date.UTC(2026, 9, 25, 0, 30) },
    });
    expect(second).toMatchObject({
      output: { value: Date.UTC(2026, 9, 25, 1, 30) },
    });
  });
  it.each([
    '2026-02-29T00:00:00Z',
    '2024-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00',
    '2026-01-01T00:00:00.1234Z',
    '2026-01-01T00:00:00+24:00',
    '0000-01-01T00:00:00+00:01',
    '9999-12-31T23:59:59.999-00:01',
    'tomorrow',
    '01/02/2026',
  ])('rejects ambiguous/invalid instant %s', async (value) => {
    await expect(run('to_epoch_millis', value)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
  it('does not coerce or guess numeric input units', async () => {
    for (const value of [0.5, '0', -62_167_219_200_001, 253_402_300_800_000])
      await expect(run('to_iso', value)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    await expect(run('to_epoch_millis', 0)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await run('to_iso', 1)).toMatchObject({
      output: { value: '1970-01-01T00:00:00.001Z' },
    });
    expect(await run('to_epoch_millis', '2000-02-29T00:00:00Z')).toMatchObject({
      output: { value: Date.UTC(2000, 1, 29) },
    });
  });
  it('uses the same registry result after fresh process starts under different host timezones', () => {
    const source = new URL('../src/server.ts', import.meta.url).href;
    const script = `import { createCoreNodeRegistry } from ${JSON.stringify(source)}; const result = await createCoreNodeRegistry().execute({definition:{key:'core.date',version:1},executor:{key:'core.date',version:1},config:{operation:'to_epoch_millis'},input:{value:'2026-03-29T02:30:00+01:00'},signal:new AbortController().signal}); process.stdout.write(JSON.stringify(result));`;
    const results = ['UTC', 'America/New_York', 'Europe/Belgrade'].map((TZ) => {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { env: { ...process.env, TZ }, encoding: 'utf8', timeout: 10_000 },
      );
      expect(child.status).toBe(0);
      return child.stdout;
    });
    expect(new Set(results).size).toBe(1);
    expect(JSON.parse(results[0] ?? '{}') as unknown).toMatchObject({
      output: { value: Date.UTC(2026, 2, 29, 1, 30) },
    });
  });
});
