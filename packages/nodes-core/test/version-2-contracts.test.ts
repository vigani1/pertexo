import { describe, expect, it } from 'vitest';

import {
  CORE_MERGE_INPUT_SCHEMA,
  CORE_MERGE_INPUT_SCHEMA_V2,
  CORE_PARALLEL_OUTPUT_SCHEMA_V2,
  CORE_SCHEDULE_CONFIG_SCHEMA,
  CORE_SCHEDULE_CONFIG_SCHEMA_V2,
  CORE_SCHEDULE_INPUT_SCHEMA_V2,
} from '../src/index.js';

describe('version 2 Schedule contract', () => {
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
  ])('rejects cron text that cannot be materialized: %s', (expression) => {
    const candidate = {
      expression,
      kind: 'cron' as const,
      misfirePolicy: 'catch_up_once' as const,
      timezone: 'Europe/Belgrade',
    };
    expect(CORE_SCHEDULE_CONFIG_SCHEMA_V2.safeParse(candidate).success).toBe(
      false,
    );
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
});

describe('version 2 structured-node contracts', () => {
  it('requires unique Parallel output branches', () => {
    expect(
      CORE_PARALLEL_OUTPUT_SCHEMA_V2.safeParse({
        branchIds: ['branch-01', 'branch-01'],
      }).success,
    ).toBe(false);
  });

  it.each([
    { ledger: {}, selectedBranchIds: [] },
    {
      ledger: { 'branch-01': { disposition: 'pending' } },
      selectedBranchIds: [],
    },
    {
      ledger: { 'branch-01': { disposition: 'skipped' } },
      selectedBranchIds: ['branch-01'],
    },
    {
      ledger: { 'branch-01': { disposition: 'arrived' } },
      selectedBranchIds: ['branch-02'],
    },
    {
      ledger: { 'branch-01': { disposition: 'arrived' } },
      selectedBranchIds: ['branch-01', 'branch-01'],
    },
    {
      ledger: {
        'branch-01': { disposition: 'arrived' },
        'branch-02': { disposition: 'arrived' },
      },
      selectedBranchIds: ['branch-02', 'branch-01'],
    },
  ])('rejects impossible Merge state %#', (candidate) => {
    expect(CORE_MERGE_INPUT_SCHEMA_V2.safeParse(candidate).success).toBe(false);
  });

  it('accepts every settled disposition and a canonical arrived selection', () => {
    const candidate = {
      ledger: {
        'branch-01': { disposition: 'arrived', output: { value: 1 } },
        'branch-02': { disposition: 'skipped' },
        'branch-03': { disposition: 'missing' },
        'branch-04': { disposition: 'failed' },
        'branch-05': { disposition: 'canceled' },
      },
      selectedBranchIds: ['branch-01'],
    };
    expect(CORE_MERGE_INPUT_SCHEMA_V2.parse(candidate)).toEqual(candidate);
    expect(
      CORE_MERGE_INPUT_SCHEMA.safeParse({ ledger: {}, selectedBranchIds: [] })
        .success,
    ).toBe(true);
  });
});
