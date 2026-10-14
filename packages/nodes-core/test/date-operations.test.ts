import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createCoreNodeRegistry } from '../src/server.js';
const registry = createCoreNodeRegistry();
const run = (config: unknown, value: unknown, amount?: number) =>
  registry.execute({
    definition: { key: 'core.date', version: 1 },
    executor: { key: 'core.date', version: 1 },
    config,
    input: { value, ...(amount === undefined ? {} : { amount }) },
    signal: new AbortController().signal,
  });
describe('named date formats, IANA conversion and durations', () => {
  it.each([
    ['date_only', '2026-10-14'],
    ['date_time', '2026-10-14 14:30:00'],
    ['iso', '2026-10-14T14:30:00.123+02:00'],
  ])('formats %s in the chosen IANA zone', async (format, value) => {
    expect(
      await run(
        { operation: 'format', format, timeZone: 'Europe/Paris' },
        '2026-10-14T12:30:00.123Z',
      ),
    ).toMatchObject({ output: { value } });
  });
  it('converts between zones without changing the instant, including fractional-hour zones', async () => {
    const paris = await run(
      { operation: 'convert_timezone', timeZone: 'Europe/Paris' },
      '2026-10-14T08:30:00-04:00',
    );
    expect(paris).toMatchObject({
      output: { value: '2026-10-14T14:30:00.000+02:00' },
    });
    expect(
      await run(
        { operation: 'convert_timezone', timeZone: 'Asia/Kathmandu' },
        0,
      ),
    ).toMatchObject({ output: { value: '1970-01-01T05:30:00.000+05:30' } });
    expect(
      await run(
        { operation: 'convert_timezone', timeZone: 'Asia/Kathmandu' },
        '2026-10-14T00:00:00Z',
      ),
    ).toMatchObject({ output: { value: '2026-10-14T05:45:00.000+05:45' } });
  });
  it('preserves both instants in a DST fold and follows the spring transition', async () => {
    const config = {
      operation: 'convert_timezone',
      timeZone: 'America/New_York',
    };
    expect(await run(config, '2026-11-01T05:30:00Z')).toMatchObject({
      output: { value: '2026-11-01T01:30:00.000-04:00' },
    });
    expect(await run(config, '2026-11-01T06:30:00Z')).toMatchObject({
      output: { value: '2026-11-01T01:30:00.000-05:00' },
    });
    expect(await run(config, '2026-03-08T07:00:00Z')).toMatchObject({
      output: { value: '2026-03-08T03:00:00.000-04:00' },
    });
  });
  it('keeps midnight at 00 and preserves year zero in UTC', async () => {
    expect(
      await run(
        { operation: 'format', format: 'date_time', timeZone: 'UTC' },
        0,
      ),
    ).toMatchObject({ output: { value: '1970-01-01 00:00:00' } });
    expect(
      await run(
        { operation: 'convert_timezone', timeZone: 'UTC' },
        '0000-01-01T00:00:00Z',
      ),
    ).toMatchObject({ output: { value: '0000-01-01T00:00:00.000Z' } });
  });
  it.each([
    ['minutes', -30, '2026-01-31T11:30:00.000Z'],
    ['hours', 2, '2026-01-31T14:00:00.000Z'],
    ['days', 1, '2026-02-01T12:00:00.000Z'],
    ['weeks', -1, '2026-01-24T12:00:00.000Z'],
    ['months', 1, '2026-02-28T12:00:00.000Z'],
    ['months', -1, '2025-12-31T12:00:00.000Z'],
  ])('adds signed %s duration %i', async (unit, amount, value) => {
    expect(
      await run(
        { operation: 'add_duration', unit },
        '2026-01-31T12:00:00Z',
        amount,
      ),
    ).toMatchObject({ output: { value } });
  });
  it('clamps leap month/year ends, subtracts months and uses elapsed days over DST', async () => {
    expect(
      await run(
        { operation: 'add_duration', unit: 'months' },
        '2024-01-31T00:00:00Z',
        1,
      ),
    ).toMatchObject({ output: { value: '2024-02-29T00:00:00.000Z' } });
    expect(
      await run(
        { operation: 'add_duration', unit: 'months' },
        '2024-02-29T00:00:00Z',
        12,
      ),
    ).toMatchObject({ output: { value: '2025-02-28T00:00:00.000Z' } });
    expect(
      await run(
        { operation: 'add_duration', unit: 'months' },
        '2026-03-31T00:00:00Z',
        -1,
      ),
    ).toMatchObject({ output: { value: '2026-02-28T00:00:00.000Z' } });
    expect(
      await run(
        { operation: 'add_duration', unit: 'days' },
        '2026-03-07T12:00:00-05:00',
        1,
      ),
    ).toMatchObject({ output: { value: '2026-03-08T17:00:00.000Z' } });
  });
  it('refuses inferred wall time, duration overflow and missing/wrong amounts', async () => {
    for (const [value, amount, unit] of [
      ['2026-01-01T00:00:00', 1, 'days'],
      ['9999-12-31T00:00:00Z', 1, 'months'],
      ['0000-01-01T00:00:00Z', -1, 'days'],
      [0, Number.MAX_SAFE_INTEGER, 'weeks'],
      [0, 0.5, 'months'],
      [0, undefined, 'hours'],
    ])
      await expect(
        run(
          { operation: 'add_duration', unit },
          value,
          amount as number | undefined,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await run({ operation: 'to_iso' }, 0, 1)).toMatchObject({
      output: { value: '1970-01-01T00:00:00.000Z' },
    });
  });
  it('rejects unknown, host-default and numeric-offset zone selectors', async () => {
    for (const timeZone of ['Moon/Base', '+02:00', '', undefined])
      await expect(
        run(
          {
            operation: 'convert_timezone',
            ...(timeZone === undefined ? {} : { timeZone }),
          },
          0,
        ),
      ).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(
      run({ operation: 'format', format: 'MM/DD/yyyy', timeZone: 'UTC' }, 0),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });
  it('does not silently round historical sub-minute offsets in ISO output', async () => {
    await expect(
      run(
        { operation: 'convert_timezone', timeZone: 'Europe/Paris' },
        '1890-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(
      await run(
        { operation: 'format', format: 'date_time', timeZone: 'Europe/Paris' },
        '1890-01-01T00:00:00Z',
      ),
    ).toMatchObject({ output: { value: '1890-01-01 00:09:21' } });
  });
  it('has identical results after restart under different host timezones', () => {
    const source = new URL('../src/server.ts', import.meta.url).href;
    const script = `import {createCoreNodeRegistry} from ${JSON.stringify(source)};const registry=createCoreNodeRegistry();const results=[];for(const config of [{operation:'convert_timezone',timeZone:'Europe/Paris'},{operation:'format',format:'date_time',timeZone:'America/New_York'},{operation:'add_duration',unit:'months'}])results.push(await registry.execute({definition:{key:'core.date',version:1},executor:{key:'core.date',version:1},config,input:{value:'2026-01-31T12:00:00Z',...(config.operation==='add_duration'?{amount:1}:{})},signal:new AbortController().signal}));process.stdout.write(JSON.stringify(results));`;
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
  });
});
