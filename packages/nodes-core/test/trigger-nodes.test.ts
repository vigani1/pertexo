import { describe, expect, it } from 'vitest';

import {
  CORE_SCHEDULE_CONFIG_SCHEMA,
  CORE_SCHEDULE_CONFIG_SCHEMA_V2,
  CORE_SCHEDULE_INPUT_SCHEMA_V2,
  CORE_SCHEDULE_MANIFEST_V3,
} from '../src/index.js';

describe('core Schedule trigger contract', () => {
  it.each(['0 0 * * *', '*/5 0-23 * * 1-5', '59 23 31 12 *'])(
    'accepts strict runtime-compatible cron %s',
    (expression) => {
      expect(
        CORE_SCHEDULE_CONFIG_SCHEMA_V2.safeParse({
          expression,
          kind: 'cron',
          misfirePolicy: 'catch_up_once',
          timezone: 'Europe/Belgrade',
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    '99 99 99 99 99',
    '*/0 * * * *',
    '? ? ? ? ?',
    '0 0 1-0 * *',
    '0 0 * *',
    '0  0 * * *',
    ' 0 0 * * *',
    '0\t 9 * * *',
    '0 \t9 * * *',
    '0\n 9 * * *',
  ])('rejects cron text that cannot be materialized: %s', (expression) => {
    expect(
      CORE_SCHEDULE_CONFIG_SCHEMA_V2.safeParse({
        expression,
        kind: 'cron',
        misfirePolicy: 'catch_up_once',
        timezone: 'Europe/Belgrade',
      }).success,
    ).toBe(false);
  });

  it('retains version 1 behavior while version 2 advertises the exact event', () => {
    expect(
      CORE_SCHEDULE_CONFIG_SCHEMA.safeParse({
        expression: '99 99 99 99 99',
        kind: 'cron',
        timezone: 'Europe/Belgrade',
      }).success,
    ).toBe(true);
    expect(
      CORE_SCHEDULE_INPUT_SCHEMA_V2.parse({
        nodeId: 'schedule',
        scheduledAt: '2026-09-05T01:00:00.000Z',
        schemaVersion: 1,
        triggerId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01',
      }),
    ).toBeDefined();
    expect(
      CORE_SCHEDULE_INPUT_SCHEMA_V2.safeParse({
        scheduledAt: '2026-09-05T01:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('publishes the runtime-only cron semantics omitted by JSON Schema', () => {
    expect(CORE_SCHEDULE_MANIFEST_V3.configSchema).toMatchObject({
      'x-pertexo-runtime-only-semantics': [
        expect.stringContaining('canonical non-fixed-offset IANA timezone'),
      ],
    });
  });
});
