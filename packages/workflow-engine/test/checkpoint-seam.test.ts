import { describe, expect, it } from 'vitest';

import {
  createCheckpoint,
  createCheckpointV2,
  invocationKey,
  parseCheckpoint,
  reconstructReadySet,
  WORKFLOW_CHECKPOINT_LIMITS_V1,
} from '../src/index.js';
import {
  withExplicitSchedulerState,
  checkpoint,
  occurredAt,
} from './support/advance-workflow.fixture.js';
import {
  advanceWorkflow as advanceWorkflowAtSeam,
  type AdvanceWorkflowInput,
} from '../src/testing.js';

function advanceWorkflow(input: AdvanceWorkflowInput) {
  return advanceWorkflowAtSeam(withExplicitSchedulerState(input));
}

describe('checkpoint seam', () => {
  it('defaults the additive retained deadline flag to false', () => {
    const { deadlineExpired: _, ...retained } = checkpoint();
    void _;
    expect(parseCheckpoint(retained).deadlineExpired).toBe(false);
    expect(checkpoint().deadlineExpired).toBe(false);
  });

  it('fails closed for an unsupported checkpoint version', () => {
    expect(() => parseCheckpoint({ schemaVersion: 3 })).toThrow(
      expect.objectContaining({ code: 'checkpoint_unsupported' }),
    );
  });

  it('resolves a retained V1 synthetic loop to its canonical parent key', () => {
    const base = checkpoint();
    const controlKey = invocationKey({
      workflowVersionId: base.workflowVersionId,
      nodeId: 'legacy-loop',
    });
    const iterationKey = invocationKey({
      workflowVersionId: base.workflowVersionId,
      nodeId: 'legacy-loop',
      iterationPath: [{ loopNodeId: 'legacy-loop', ordinal: 0 }],
    });
    const parsed = parseCheckpoint({
      ...base,
      runStatus: 'running',
      invocations: [
        {
          invocationKey: controlKey,
          nodeId: 'legacy-loop',
          status: 'waiting',
          attemptNumber: 1,
        },
        {
          invocationKey: iterationKey,
          nodeId: 'legacy-loop',
          status: 'running',
          attemptNumber: 1,
        },
      ],
      loops: [
        {
          loopId: 'legacy-loop',
          collection: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000201',
          },
          collectionChecksum: 'legacy-checksum',
          collectionSize: 1,
          maxConcurrency: 1,
          maxIterations: 1,
          nextOrdinal: 1,
          activeOrdinals: [0],
          terminalOrdinals: [],
        },
      ],
      remainingIterationBudget: base.remainingIterationBudget - 1,
    });

    expect(parsed.loops[0]?.controlInvocationKey).toBe(controlKey);
    expect(parsed.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ invocationKey: controlKey }),
      ]),
    );
    const recovered = advanceWorkflow({
      checkpoint: parsed,
      occurredAt,
      maximumAdmissions: 0,
      observations: [],
    });
    expect(recovered.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0],
      terminalOrdinals: [],
    });
    const completed = advanceWorkflow({
      checkpoint: recovered.checkpoint,
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'loop_iteration_completed',
          loopId: 'legacy-loop',
          invocationKey: iterationKey,
          ordinal: 0,
          status: 'succeeded',
        },
      ],
    });
    expect(completed.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      terminalOrdinals: [0],
    });
    expect(
      completed.checkpoint.invocations.find(
        ({ invocationKey: key }) => key === controlKey,
      ),
    ).toMatchObject({ status: 'succeeded' });
  });

  it('rejects malformed present optional scope fields', () => {
    const base = checkpoint();
    const controlKey = invocationKey({
      workflowVersionId: base.workflowVersionId,
      nodeId: 'legacy-loop',
    });
    const retained = {
      ...base,
      invocations: [
        {
          invocationKey: controlKey,
          nodeId: 'legacy-loop',
          status: 'succeeded',
          attemptNumber: 1,
        },
      ],
      loops: [
        {
          loopId: 'legacy-loop',
          collection: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000202',
          },
          collectionChecksum: 'legacy-checksum',
          collectionSize: 0,
          maxConcurrency: 1,
          maxIterations: 1,
          nextOrdinal: 0,
          activeOrdinals: [],
          terminalOrdinals: [],
          branchPath: null,
        },
      ],
    };

    expect(() => parseCheckpoint(retained)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(() =>
      parseCheckpoint({
        ...retained,
        loops: [
          {
            ...retained.loops[0],
            branchPath: [],
            controlInvocationKey: 42,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...base,
        joins: [
          {
            joinId: 'join',
            joinInvocationKey: 42,
            policy: { kind: 'all' },
            ledger: [{ branchId: 'branch', disposition: 'pending' }],
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...retained,
        loops: [
          {
            ...retained.loops[0],
            branchPath: [],
            bodyRootNodeIds: 'legacy-loop',
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('requires due time for an ordinary waiting invocation', () => {
    const base = checkpoint();
    expect(() =>
      parseCheckpoint({
        ...base,
        invocations: [
          {
            invocationKey: 'ordinary',
            nodeId: 'ordinary',
            status: 'waiting',
            attemptNumber: 1,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));

    const running = advanceWorkflow({
      checkpoint: base,
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        { kind: 'ready', invocationKey: 'ordinary', nodeId: 'ordinary' },
      ],
    });
    const waiting = advanceWorkflow({
      checkpoint: running.checkpoint,
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'wait',
          waitKind: 'node_wait',
          invocationKey: 'ordinary',
          resumeAt: '2026-08-21T10:00:00.000Z',
        },
      ],
    });
    expect(() =>
      advanceWorkflow({
        checkpoint: waiting.checkpoint,
        occurredAt,
        maximumAdmissions: 0,
        observations: [
          {
            kind: 'outcome',
            invocationKey: 'ordinary',
            status: 'failed',
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'transition_invalid' }));
  });

  it('rejects structured For Each state generation from checkpoint V1', () => {
    expect(() =>
      advanceWorkflow({
        checkpoint: checkpoint(),
        occurredAt,
        maximumAdmissions: 0,
        observations: [
          {
            kind: 'loop_started',
            loopId: 'loop',
            controlInvocationKey: invocationKey({
              workflowVersionId: '00000000-0000-4000-8000-000000000001',
              nodeId: 'loop',
            }),
            bodyRootNodeIds: ['body'],
            bodySinkNodeId: 'body',
            collection: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000203',
            },
            collectionChecksum: 'checksum',
            collectionSize: 1,
            maxConcurrency: 1,
            maxIterations: 1,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('parses canonical V2 branch selections without reinterpreting V1', () => {
    const v1 = checkpoint();
    const conditionAKey = invocationKey({
      workflowVersionId: v1.workflowVersionId,
      nodeId: 'condition-a',
    });
    const conditionZKey = invocationKey({
      workflowVersionId: v1.workflowVersionId,
      nodeId: 'condition-z',
    });
    const parsed = parseCheckpoint({
      ...v1,
      schemaVersion: 2,
      invocations: [
        {
          invocationKey: conditionZKey,
          nodeId: 'condition-z',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000102',
          },
        },
        {
          invocationKey: conditionAKey,
          nodeId: 'condition-a',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000101',
          },
        },
      ],
      branchSelections: [
        {
          invocationKey: conditionZKey,
          nodeId: 'condition-z',
          selectedOutputPort: 'false',
        },
        {
          invocationKey: conditionAKey,
          nodeId: 'condition-a',
          selectedOutputPort: 'true',
        },
      ],
    });

    expect(parsed).toMatchObject({
      schemaVersion: 2,
      branchSelections: [
        {
          invocationKey: conditionAKey,
          nodeId: 'condition-a',
          selectedOutputPort: 'true',
        },
        {
          invocationKey: conditionZKey,
          nodeId: 'condition-z',
          selectedOutputPort: 'false',
        },
      ],
    });
    expect(parsed.invocations).not.toContainEqual(
      expect.objectContaining({ branchPath: [] }),
    );
    expect(parseCheckpoint(v1)).toEqual(v1);
    expect(parseCheckpoint(v1)).not.toHaveProperty('branchSelections');
    expect(
      createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId: '00000000-0000-4000-8000-000000000002',
        iterationBudget: 1_000,
      }),
    ).toMatchObject({ schemaVersion: 2, branchSelections: [] });
  });

  it('deduplicates identical V2 selections and rejects conflicts or non-success', () => {
    const conditionKey = invocationKey({
      workflowVersionId: checkpoint().workflowVersionId,
      nodeId: 'condition',
    });
    const selection = {
      invocationKey: conditionKey,
      nodeId: 'condition',
      selectedOutputPort: 'true',
    } as const;
    const base = {
      ...checkpoint(),
      schemaVersion: 2,
      invocations: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000101',
          },
        },
      ],
      branchSelections: [selection, selection],
    } as const;

    const parsed = parseCheckpoint(base);
    expect(parsed).toMatchObject({ branchSelections: [selection] });
    expect(() =>
      parseCheckpoint({
        ...base,
        branchSelections: [
          selection,
          { ...selection, selectedOutputPort: 'false' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...base,
        invocations: [{ ...base.invocations[0], status: 'running' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('canonicalizes collections and reconstructs ready work without transport state', () => {
    const parsed = parseCheckpoint({
      ...checkpoint(),
      readySet: ['z', 'a'],
      admittedInvocationKeys: ['z', 'a'],
      invocations: [
        { invocationKey: 'z', nodeId: 'z', status: 'ready', attemptNumber: 0 },
        { invocationKey: 'a', nodeId: 'a', status: 'ready', attemptNumber: 0 },
      ],
    });
    expect(parsed.readySet).toEqual(['a', 'z']);
    expect(
      parsed.invocations.map(({ invocationKey }) => invocationKey),
    ).toEqual(['a', 'z']);
    expect(reconstructReadySet(parsed)).toEqual(['a', 'z']);
  });

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
        engineVersion: 'x'.repeat(4 * 1_048_576),
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('enforces the persisted engine identity bound before storage', () => {
    const base = checkpoint();
    const exact = { ...base, engineVersion: `e${'x'.repeat(63)}` };
    expect(parseCheckpoint(exact).engineVersion).toBe(exact.engineVersion);
    expect(() =>
      parseCheckpoint({ ...base, engineVersion: `e${'x'.repeat(64)}` }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('admits only checkpoint identities and timestamps accepted by persistence', () => {
    expect(() =>
      createCheckpoint({
        engineVersion: '',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      createCheckpoint({
        engineVersion: 'engine-v1',
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

  it('never invokes inherited toJSON while measuring checkpoint bytes', () => {
    let getterCalls = 0;
    const original = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON',
    );
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() {
        getterCalls += 1;
        return () => checkpoint();
      },
    });
    try {
      expect(parseCheckpoint(checkpoint()).schemaVersion).toBe(1);
      expect(() =>
        parseCheckpoint({ ...checkpoint(), engineVersion: () => 'bad' }),
      ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
      expect(getterCalls).toBe(0);
    } finally {
      if (original === undefined)
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      else Object.defineProperty(Object.prototype, 'toJSON', original);
    }
  });

  it('rejects hidden fields and accessors without invoking them', () => {
    let getterCalls = 0;
    const hiddenRequired = { ...checkpoint() } as Record<string, unknown>;
    Object.defineProperty(hiddenRequired, 'engineVersion', {
      enumerable: false,
      get: () => {
        getterCalls += 1;
        return 'engine-v1';
      },
    });
    expect(() => parseCheckpoint(hiddenRequired)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(getterCalls).toBe(0);

    const hiddenUnknown = { ...checkpoint() } as Record<string, unknown>;
    Object.defineProperty(hiddenUnknown, 'hidden', {
      enumerable: false,
      value: true,
    });
    expect(() => parseCheckpoint(hiddenUnknown)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });

  it('rejects top-level and nested proxies without running their traps', () => {
    let trapCalls = 0;
    const hostile = new Proxy(checkpoint(), {
      getPrototypeOf: () => {
        trapCalls += 1;
        throw new Error('proxy trap ran');
      },
      ownKeys: () => {
        trapCalls += 1;
        throw new Error('proxy trap ran');
      },
    });
    expect(() => parseCheckpoint(hostile)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    const nested = {
      ...checkpoint(),
      invocations: [
        new Proxy(
          {
            invocationKey: 'a',
            nodeId: 'a',
            status: 'ready',
            attemptNumber: 0,
          },
          {
            getOwnPropertyDescriptor: () => {
              trapCalls += 1;
              throw new Error('nested proxy trap ran');
            },
          },
        ),
      ],
      readySet: ['a'],
    };
    expect(() => parseCheckpoint(nested)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(trapCalls).toBe(0);
  });

  it('rejects a wide object at the incremental member cap', () => {
    const wide: Record<string, number> = {};
    for (
      let index = 0;
      index <= WORKFLOW_CHECKPOINT_LIMITS_V1.members;
      index += 1
    )
      wide[`field-${String(index)}`] = index;
    const startedAt = performance.now();
    expect(() =>
      parseCheckpoint({ ...checkpoint(), engineVersion: wide }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
