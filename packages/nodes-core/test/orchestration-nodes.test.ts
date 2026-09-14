import { describe, expect, it } from 'vitest';
import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';

import {
  CORE_FOR_EACH_CONFIG_SCHEMA,
  CORE_FOR_EACH_DEFINITION,
  CORE_FOR_EACH_EXECUTOR,
  CORE_FOR_EACH_INPUT_SCHEMA,
  CORE_FOR_EACH_MANIFEST,
  CORE_FOR_EACH_OUTPUT_SCHEMA,
  CORE_MERGE_CONFIG_SCHEMA,
  CORE_MERGE_DEFINITION,
  CORE_MERGE_EXECUTOR,
  CORE_MERGE_INPUT_SCHEMA,
  CORE_MERGE_INPUT_SCHEMA_V2,
  CORE_MERGE_MANIFEST,
  CORE_MERGE_MANIFEST_V3,
  CORE_PARALLEL_CONFIG_SCHEMA,
  CORE_PARALLEL_DEFINITION,
  CORE_PARALLEL_EXECUTOR,
  CORE_PARALLEL_MANIFEST,
  CORE_PARALLEL_MANIFEST_V3,
  CORE_PARALLEL_OUTPUT_SCHEMA_V2,
  CORE_SWITCH_CONFIG_SCHEMA,
  CORE_SWITCH_DEFINITION,
  CORE_SWITCH_EXECUTOR,
  CORE_SWITCH_MANIFEST,
  CORE_WAIT_CONFIG_SCHEMA,
  CORE_WAIT_DEFINITION,
  CORE_WAIT_EXECUTOR,
  CORE_WAIT_MANIFEST,
} from '../src/index.js';

describe('core orchestration node contracts', () => {
  it('defines strict bounded Switch cases with stable output ports', () => {
    const config = {
      cases: [
        { id: 'case-02', equals: 'same' },
        { id: 'case-01', equals: 'same' },
      ],
    } as const;
    expect(CORE_SWITCH_CONFIG_SCHEMA.safeParse(config).success).toBe(true);
    expect(
      CORE_SWITCH_CONFIG_SCHEMA.safeParse({
        cases: [
          { id: 'case-01', equals: true },
          { id: 'case-01', equals: false },
        ],
      }).success,
    ).toBe(false);
    expect(CORE_SWITCH_MANIFEST).toMatchObject({
      definition: CORE_SWITCH_DEFINITION,
      executor: CORE_SWITCH_EXECUTOR,
      ports: {
        inputs: ['in'],
        outputs: [
          'case-01',
          'case-02',
          'case-03',
          'case-04',
          'case-05',
          'case-06',
          'case-07',
          'case-08',
          'case-09',
          'case-10',
          'case-11',
          'case-12',
          'case-13',
          'case-14',
          'case-15',
          'case-16',
          'default',
        ],
      },
    });
  });

  it('defines bounded Parallel branches and pinned concurrency', () => {
    expect(
      CORE_PARALLEL_CONFIG_SCHEMA.safeParse({
        branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
        maxConcurrency: 2,
      }).success,
    ).toBe(true);
    expect(
      CORE_PARALLEL_CONFIG_SCHEMA.safeParse({
        branches: [{ id: 'branch-01' }, { id: 'branch-01' }],
        maxConcurrency: 2,
      }).success,
    ).toBe(false);
    expect(
      CORE_PARALLEL_CONFIG_SCHEMA.safeParse({
        branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
        maxConcurrency: 3,
      }).success,
    ).toBe(false);
    expect(CORE_PARALLEL_MANIFEST).toMatchObject({
      definition: CORE_PARALLEL_DEFINITION,
      executor: CORE_PARALLEL_EXECUTOR,
      ports: { inputs: ['in'] },
    });
  });

  it('defines explicit Merge pairing and bounded join policies', () => {
    expect(
      CORE_MERGE_CONFIG_SCHEMA.safeParse({
        parallelNodeId: 'parallel',
        policy: { kind: 'count', count: 2 },
      }).success,
    ).toBe(true);
    expect(
      CORE_MERGE_CONFIG_SCHEMA.safeParse({
        parallelNodeId: 'parallel',
        policy: { kind: 'count', count: 0 },
      }).success,
    ).toBe(false);
    expect(CORE_MERGE_MANIFEST).toMatchObject({
      definition: CORE_MERGE_DEFINITION,
      executor: CORE_MERGE_EXECUTOR,
      ports: { outputs: ['out'] },
    });
  });

  it('defines a strict bounded For Each declaration contract', () => {
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.parse({
        items: [{ id: 'first' }, null, 3],
      }),
    ).toEqual({ items: [{ id: 'first' }, null, 3] });
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({ items: [], extra: true }).success,
    ).toBe(false);
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({
        items: Array.from({ length: 1_001 }, () => null),
      }).success,
    ).toBe(false);
    expect(CORE_FOR_EACH_CONFIG_SCHEMA.safeParse({}).success).toBe(true);
    expect(
      CORE_FOR_EACH_CONFIG_SCHEMA.safeParse({ maxIterations: 3 }).success,
    ).toBe(false);
    expect(CORE_FOR_EACH_MANIFEST).toMatchObject({
      definition: CORE_FOR_EACH_DEFINITION,
      executor: CORE_FOR_EACH_EXECUTOR,
      family: 'logic',
      ports: { inputs: ['in'], outputs: ['out'] },
      retryClass: 'safe',
      resourceClass: 'cpu',
    });
  });

  it('bounds For Each JSON before recursive schema traversal', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = null;
    for (let index = 0; index < 500; index += 1) deep = { child: deep };
    for (const candidate of [{ items: [cyclic] }, { items: [deep] }]) {
      expect(() =>
        CORE_FOR_EACH_INPUT_SCHEMA.safeParse(candidate),
      ).not.toThrow();
      expect(CORE_FOR_EACH_INPUT_SCHEMA.safeParse(candidate).success).toBe(
        false,
      );
      expect(() =>
        CORE_FOR_EACH_OUTPUT_SCHEMA.safeParse({
          ...candidate,
          iterationCount: 1,
        }),
      ).not.toThrow();
      expect(
        CORE_FOR_EACH_OUTPUT_SCHEMA.safeParse({
          ...candidate,
          iterationCount: 1,
        }).success,
      ).toBe(false);
    }
  });

  it('accepts exact For Each JSON limits and rejects one unit over', () => {
    const nested = (levels: number): unknown => {
      let value: unknown = null;
      for (let index = 0; index < levels; index += 1) value = [value];
      return value;
    };
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({ items: [nested(62)] }).success,
    ).toBe(true);
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({ items: [nested(63)] }).success,
    ).toBe(false);

    const members = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [String(index), null]),
      );
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({ items: [members(9_998)] }).success,
    ).toBe(true);
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({ items: [members(9_999)] }).success,
    ).toBe(false);

    const baseBytes = new TextEncoder().encode(
      JSON.stringify({ items: [''] }),
    ).byteLength;
    const exactItem = 'x'.repeat(NODE_JSON_LIMITS_V1.bytes - baseBytes);
    const exact = { items: [exactItem] };
    expect(CORE_FOR_EACH_INPUT_SCHEMA.safeParse(exact).success).toBe(true);
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({
        items: [`${exactItem}x`],
      }).success,
    ).toBe(false);
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({
        items: Array.from({ length: 1_000 }, () => null),
      }).success,
    ).toBe(true);
    expect(
      CORE_FOR_EACH_INPUT_SCHEMA.safeParse({
        items: Array.from({ length: 1_001 }, () => null),
      }).success,
    ).toBe(false);
  });

  it('returns an owned For Each snapshot and retains output cardinality', () => {
    const input = { items: [{ value: 1 }] };
    const parsed = CORE_FOR_EACH_INPUT_SCHEMA.parse(input);
    const item = input.items[0];
    if (item === undefined) throw new Error('missing test item');
    item.value = 2;
    expect(parsed).toEqual({ items: [{ value: 1 }] });
    expect(input).toEqual({ items: [{ value: 2 }] });
    expect(
      CORE_FOR_EACH_OUTPUT_SCHEMA.safeParse({
        items: [null],
        iterationCount: 0,
      }).success,
    ).toBe(false);
  });

  it('defines the bounded suspension contract for Wait', () => {
    expect(
      CORE_WAIT_CONFIG_SCHEMA.safeParse({ durationSeconds: 1 }).success,
    ).toBe(true);
    expect(
      CORE_WAIT_CONFIG_SCHEMA.safeParse({ durationSeconds: 2_592_000 }).success,
    ).toBe(true);
    expect(
      CORE_WAIT_CONFIG_SCHEMA.safeParse({ durationSeconds: 0 }).success,
    ).toBe(false);
    expect(
      CORE_WAIT_CONFIG_SCHEMA.safeParse({ durationSeconds: 2_592_001 }).success,
    ).toBe(false);
    expect(
      CORE_WAIT_CONFIG_SCHEMA.safeParse({ durationSeconds: 1, extra: true })
        .success,
    ).toBe(false);
    expect(CORE_WAIT_MANIFEST).toMatchObject({
      definition: CORE_WAIT_DEFINITION,
      executor: CORE_WAIT_EXECUTOR,
      family: 'logic',
      ports: { inputs: ['in'], outputs: ['out'] },
      retryClass: 'safe',
      resourceClass: 'cpu',
      capabilities: ['suspends_run'],
    });
  });

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

  it('publishes runtime-only structured-node refinements for browser consumers', () => {
    expect(CORE_PARALLEL_MANIFEST_V3.configSchema).toMatchObject({
      'x-pertexo-runtime-only-semantics': [
        expect.stringContaining('maxConcurrency'),
      ],
    });
    expect(CORE_PARALLEL_MANIFEST_V3.outputSchema).toMatchObject({
      'x-pertexo-runtime-only-semantics': [expect.stringContaining('unique')],
    });
    for (const schema of [
      CORE_MERGE_MANIFEST_V3.inputSchema,
      CORE_MERGE_MANIFEST_V3.outputSchema,
    ])
      expect(schema).toMatchObject({
        'x-pertexo-runtime-only-semantics': [
          expect.stringContaining('canonically ordered'),
        ],
      });
  });
});
