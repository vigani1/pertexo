import { describe, expect, it } from 'vitest';
import { createCheckpoint, parseCheckpoint } from '../../../src/index.js';
import { checkpoint } from '../../support/advance-workflow.js';

describe('checkpoint seam', () => {
  it.each([
    [
      'invalid output reference',
      {
        invocations: [
          {
            invocationKey: 'done',
            nodeId: 'done',
            status: 'succeeded',
            attemptNumber: 1,
            output: { kind: 'inline', attemptId: 'not-a-uuid' },
          },
        ],
      },
    ],
    [
      'duplicate join IDs',
      {
        joins: [
          { joinId: 'join', policy: { kind: 'all' }, ledger: [] },
          { joinId: 'join', policy: { kind: 'all' }, ledger: [] },
        ],
      },
    ],
    [
      'inconsistent persisted join selection',
      {
        joins: [
          {
            joinId: 'join',
            policy: { kind: 'any' },
            ledger: [
              { branchId: 'a', disposition: 'arrived' },
              { branchId: 'b', disposition: 'arrived' },
            ],
            selectedBranchIds: ['b'],
          },
        ],
      },
    ],
    [
      'duplicate loop IDs',
      {
        loops: [
          {
            loopId: 'loop',
            collection: {
              kind: 'artifact',
              artifactId: '00000000-0000-4000-8000-000000000101',
            },
            collectionChecksum: 'sha256:a',
            collectionSize: 0,
            maxConcurrency: 1,
            maxIterations: 1,
            nextOrdinal: 0,
            activeOrdinals: [],
            terminalOrdinals: [],
          },
          {
            loopId: 'loop',
            collection: {
              kind: 'artifact',
              artifactId: '00000000-0000-4000-8000-000000000101',
            },
            collectionChecksum: 'sha256:a',
            collectionSize: 0,
            maxConcurrency: 1,
            maxIterations: 1,
            nextOrdinal: 0,
            activeOrdinals: [],
            terminalOrdinals: [],
          },
        ],
      },
    ],
    [
      'loop cursor gap',
      {
        loops: [
          {
            loopId: 'loop',
            collection: {
              kind: 'artifact',
              artifactId: '00000000-0000-4000-8000-000000000101',
            },
            collectionChecksum: 'sha256:a',
            collectionSize: 3,
            maxConcurrency: 1,
            maxIterations: 3,
            nextOrdinal: 2,
            activeOrdinals: [],
            terminalOrdinals: [],
          },
        ],
      },
    ],
  ] as const)('fails closed on %s', (_label, change) => {
    expect(() => parseCheckpoint({ ...checkpoint(), ...change })).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });
  it('rejects oversized and accessor-backed checkpoint collections before traversal', () => {
    const oversized = {
      ...checkpoint(),
      readySet: Array.from(
        { length: 10_001 },
        (_, index) => `node-${String(index)}`,
      ),
    };
    expect(() => parseCheckpoint(oversized)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );

    const accessorBacked = { ...checkpoint() } as Record<string, unknown>;
    Object.defineProperty(accessorBacked, 'invocations', {
      enumerable: true,
      get: () => [],
    });
    expect(() => parseCheckpoint(accessorBacked)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );

    const hugeSparse: unknown[] = [];
    hugeSparse.length = 4_294_967_295;
    expect(() =>
      parseCheckpoint({ ...checkpoint(), invocations: hugeSparse }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
  it('rejects non-JSON structure, unknown fields, and the byte-limit one-over', () => {
    expect(() =>
      parseCheckpoint({ ...checkpoint(), unexpected: true }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint(
        Object.assign(Object.create({ inherited: true }), checkpoint()),
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() =>
      parseCheckpoint({ ...checkpoint(), invocations: sparse }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...checkpoint(),
        readySet: ['x'.repeat(4 * 1_048_576)],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
  it('admits only checkpoint identities and timestamps accepted by persistence', () => {
    expect(() =>
      createCheckpoint({
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));

    const waiting = {
      ...checkpoint(),
      runStatus: 'waiting',
      invocations: [
        {
          invocationKey: 'wait',
          nodeId: 'wait',
          status: 'waiting',
          attemptNumber: 1,
          resumeAt: '0',
          waitKind: 'node_wait',
        },
      ],
    };
    expect(() => parseCheckpoint(waiting)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );

    for (const resumeAt of [
      '2026-02-29T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-09-12T24:00:00Z',
      '2026-13-01T00:00:00Z',
    ])
      expect(() =>
        parseCheckpoint({
          ...waiting,
          invocations: [{ ...waiting.invocations[0], resumeAt }],
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'checkpoint_invalid',
          message: 'resumeAt must be a canonical UTC timestamp',
        }),
      );
    for (const resumeAt of [
      '2024-02-29T00:00:00Z',
      '2026-09-12T10:00:00Z',
      '2026-09-12T10:00:00.000Z',
    ])
      expect(
        parseCheckpoint({
          ...waiting,
          invocations: [{ ...waiting.invocations[0], resumeAt }],
        }).invocations[0],
      ).toMatchObject({ resumeAt });
  });
  it('distinguishes traversal exits from cyclic checkpoint values', () => {
    const selfCycle: Record<string, unknown> = {};
    selfCycle.self = selfCycle;
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { first };
    first.second = second;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    for (const cyclic of [selfCycle, first, cyclicArray])
      expect(() =>
        parseCheckpoint({ ...checkpoint(), unexpected: cyclic }),
      ).toThrow(
        expect.objectContaining({
          code: 'checkpoint_invalid',
          message: 'checkpoint must not contain cycles',
        }),
      );

    const sharedOutput = {
      kind: 'inline',
      attemptId: '00000000-0000-4000-8000-000000000101',
    } as const;
    expect(
      parseCheckpoint({
        ...checkpoint(),
        invocations: [
          {
            invocationKey: 'shared-a',
            nodeId: 'shared-a',
            status: 'succeeded',
            attemptNumber: 1,
            output: sharedOutput,
          },
          {
            invocationKey: 'shared-b',
            nodeId: 'shared-b',
            status: 'succeeded',
            attemptNumber: 1,
            output: sharedOutput,
          },
        ],
      }).invocations,
    ).toHaveLength(2);
  });
  it('accounts for escaped and surrogate-pair bytes in bounded identifiers', () => {
    const invocationKey = 'quoted"\n😀';
    const parsed = parseCheckpoint({
      ...checkpoint(),
      invocations: [
        {
          invocationKey,
          nodeId: 'node',
          status: 'succeeded',
          attemptNumber: 1,
        },
      ],
    });
    expect(parsed.invocations[0]?.invocationKey).toBe(invocationKey);
  });
});
