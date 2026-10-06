import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  createCheckpointV2,
  invocationKey,
  parseCheckpoint,
  type BranchScopePart,
  type IterationScopePart,
  type WorkflowCheckpoint,
  type WorkflowObservation,
} from '../src/testing.js';
import { createWorkflowCheckpointV3 } from '../src/checkpoint/checkpoint-v3.js';
import {
  advanceWorkflow as advanceExecutable,
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
} from '../src/index.js';
import {
  nodeRelease,
  pairedParallelGraph,
} from './executable-workflow.fixtures.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000801';
const occurredAt = '2026-10-05T00:00:00.000Z';
const output = {
  kind: 'inline' as const,
  attemptId: '00000000-0000-4000-8000-000000000802',
};
type Scope = Readonly<{
  branchPath?: readonly BranchScopePart[];
  iterationPath?: readonly IterationScopePart[];
}>;
function key(nodeId: string, scope: Scope = {}) {
  return invocationKey({
    workflowVersionId,
    nodeId,
    ...(scope.branchPath === undefined
      ? {}
      : {
          branchPath: scope.branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
        }),
    ...(scope.iterationPath === undefined
      ? {}
      : { iterationPath: scope.iterationPath }),
  });
}
const schedulerState = {
  deriveReadiness: false,
  nodes: [
    {
      id: 'parallel',
      definition: { key: 'core.parallel', version: 1 },
      sideEffectClass: 'safe',
    },
    {
      id: 'merge',
      definition: { key: 'core.merge', version: 1 },
      config: { parallelNodeId: 'parallel' },
      sideEffectClass: 'safe',
    },
    { id: 'branch', sideEffectClass: 'unsafe' },
  ],
  edges: [],
} as const;
function checkpoint(
  control: 'cancel' | 'deadline',
  scope: Scope = {},
): WorkflowCheckpoint {
  return {
    ...createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId,
      iterationBudget: 10,
    }),
    runStatus: 'running',
    cancelRequested: control === 'cancel',
    deadlineExpired: control === 'deadline',
    admittedInvocationKeys: [key('parallel', scope), key('branch', scope)],
    invocations: [
      {
        invocationKey: key('parallel', scope),
        nodeId: 'parallel',
        status: 'succeeded',
        attemptNumber: 1,
        output,
        ...scope,
      },
      {
        invocationKey: key('merge', scope),
        nodeId: 'merge',
        status: 'canceled',
        attemptNumber: 0,
        ...scope,
      },
      {
        invocationKey: key('branch', scope),
        nodeId: 'branch',
        status: 'running',
        attemptNumber: 1,
        ...scope,
      },
    ],
    joins: [
      {
        joinId: 'merge',
        joinInvocationKey: key('merge', scope),
        policy: { kind: 'all' },
        ledger: [{ branchId: 'a', disposition: 'pending' }],
        ...scope,
      },
    ],
  };
}
function advance(
  current: WorkflowCheckpoint,
  observations: readonly WorkflowObservation[] = [],
) {
  return advanceWorkflow({
    checkpoint: current,
    schedulerState,
    observations,
    occurredAt,
    maximumAdmissions: 10,
  });
}

describe('stopped native Merge recovery at the public transition seam', () => {
  it.each(['succeeded', 'failed', 'outcome_unknown'] as const)(
    'reconciles a real native Parallel branch %s without restarting its canceled Merge',
    async (status) => {
      const graph = pairedParallelGraph();
      const executable = buildWorkflowExecutableV3({
        graph: { ...graph, schemaVersion: 2 },
        release: composeExecutableCompatibilityReleaseV3(
          nodeRelease({ parallel: true, merge: true }),
        ),
      });
      const current = checkpoint('cancel');
      const branchOutput = {
        kind: 'inline' as const,
        attemptId: '00000000-0000-4000-8000-000000000803',
      };
      const leftScope = {
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-01' }],
      };
      const rightScope = {
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-02' }],
      };
      const input = {
        runId: 'stopped-native-merge',
        workflowVersionId,
        executable,
        occurredAt,
        maximumAdmissions: 10,
        signal: new AbortController().signal,
      };
      const plan = await advanceExecutable({
        ...input,
        checkpoint: {
          ...current,
          admittedInvocationKeys: [key('parallel'), key('left', leftScope)],
          invocations: [
            ...current.invocations.filter(({ nodeId }) => nodeId !== 'branch'),
            {
              invocationKey: key('left', leftScope),
              nodeId: 'left',
              status: 'running',
              attemptNumber: 1,
              ...leftScope,
            },
            {
              invocationKey: key('right', rightScope),
              nodeId: 'right',
              status: 'canceled',
              attemptNumber: 0,
              ...rightScope,
            },
          ],
          joins: [
            {
              ...current.joins[0],
              ledger: [
                { branchId: 'branch-01', disposition: 'pending' },
                { branchId: 'branch-02', disposition: 'pending' },
              ],
            },
          ],
        },
        observations: [
          {
            kind: 'outcome',
            sequence: current.nextEventSequence,
            occurredAt,
            attemptId: branchOutput.attemptId,
            invocationKey: key('left', leftScope),
            attemptNumber: 1,
            status,
            ...(status === 'succeeded' ? { output: branchOutput } : {}),
          },
        ],
      });
      expect(plan.checkpoint.joins[0]?.ledger).toEqual([
        {
          branchId: 'branch-01',
          disposition: status === 'succeeded' ? 'arrived' : 'failed',
          ...(status === 'succeeded' ? { output: branchOutput } : {}),
        },
        { branchId: 'branch-02', disposition: 'canceled' },
      ]);
      expect(plan.checkpoint.joins[0]).not.toHaveProperty('selectedBranchIds');
      expect(plan.checkpoint.joins[0]).not.toHaveProperty(
        'unsatisfiedReasonCode',
      );
      expect(plan.checkpoint.runStatus).toBe(
        status === 'outcome_unknown' ? status : 'canceled',
      );
      expect(plan.attempts).toEqual([]);
      expect(
        plan.checkpoint.invocations.find(({ nodeId }) => nodeId === 'parallel'),
      ).toMatchObject({ status: 'succeeded', attemptNumber: 1, output });
      const merge = plan.checkpoint.invocations.find(
        ({ nodeId }) => nodeId === 'merge',
      );
      expect(merge).toMatchObject({ status: 'canceled', attemptNumber: 0 });
      expect(merge).not.toHaveProperty('output');
      const recovered = await advanceExecutable({
        ...input,
        checkpoint: structuredClone(plan.checkpoint),
        observations: [],
      });
      expect(recovered.checkpoint.joins).toEqual(plan.checkpoint.joins);
      expect(recovered.events).toEqual([]);
      expect(recovered.attempts).toEqual([]);
    },
  );
  it.each(['cancel', 'deadline'] as const)(
    'retains a never-started Merge after %s while recording late branch truth',
    (control) => {
      for (const disposition of ['arrived', 'failed'] as const) {
        const current = checkpoint(control);
        const plan = advance(current, [
          {
            kind: 'outcome',
            invocationKey: key('branch'),
            status: disposition === 'arrived' ? 'succeeded' : 'failed',
          },
          {
            kind: 'branch_disposition',
            joinId: 'merge',
            branch: { branchId: 'a', disposition },
          },
        ]);
        expect(plan.checkpoint.joins).toEqual([
          {
            ...current.joins[0],
            branchPath: [],
            iterationPath: [],
            ledger: [{ branchId: 'a', disposition }],
          },
        ]);
        expect(
          plan.checkpoint.invocations.find(({ nodeId }) => nodeId === 'merge'),
        ).toMatchObject({ status: 'canceled', attemptNumber: 0 });
        expect(plan.attempts).toEqual([]);
        expect(plan.events.filter(({ nodeId }) => nodeId === 'merge')).toEqual(
          [],
        );
        expect(plan.checkpoint.runStatus).toBe(
          control === 'cancel' ? 'canceled' : 'timed_out',
        );
        expect(parseCheckpoint(plan.checkpoint)).toEqual(plan.checkpoint);
        const recovered = advance(structuredClone(plan.checkpoint));
        expect(recovered.checkpoint.joins).toEqual(plan.checkpoint.joins);
        expect(recovered.attempts).toEqual([]);
        expect(recovered.events).toEqual([]);
      }
    },
  );

  it('keeps later unknown branch effects above the retained parent stop', () => {
    const plan = advance(checkpoint('cancel'), [
      {
        kind: 'outcome',
        invocationKey: key('branch'),
        status: 'outcome_unknown',
      },
      {
        kind: 'branch_disposition',
        joinId: 'merge',
        branch: { branchId: 'a', disposition: 'failed' },
      },
    ]);
    expect(plan.checkpoint.runStatus).toBe('outcome_unknown');
    expect(plan.checkpoint.joins[0]).not.toHaveProperty(
      'unsatisfiedReasonCode',
    );
    expect(parseCheckpoint(plan.checkpoint)).toEqual(plan.checkpoint);
  });

  it.each([
    { branchPath: [{ nodeId: 'outer', outputPort: 'left' }] },
    { iterationPath: [{ loopNodeId: 'loop', ordinal: 2 }] },
    {
      branchPath: [{ nodeId: 'outer', outputPort: 'left' }],
      iterationPath: [{ loopNodeId: 'loop', ordinal: 2 }],
    },
  ])('preserves an exactly scoped stopped Merge %#', (scope) => {
    const current = checkpoint('cancel', scope);
    const plan = advance(current, [
      {
        kind: 'branch_disposition',
        joinId: 'merge',
        joinInvocationKey: key('merge', scope),
        branch: { branchId: 'a', disposition: 'arrived' },
      },
    ]);
    expect(plan.checkpoint.joins[0]).toMatchObject({
      ...scope,
      ledger: [{ branchId: 'a', disposition: 'arrived' }],
    });
    expect(plan.checkpoint.joins[0]).not.toHaveProperty('selectedBranchIds');
    expect(plan.attempts).toEqual([]);
  });

  it('preserves ordinary settlement for a legacy root join without canonical invocation identity', () => {
    const current = checkpoint('cancel');
    const legacy = {
      ...current,
      joins: current.joins.map(
        ({ joinInvocationKey: _identity, ...join }) => join,
      ),
    };
    const parsed = parseCheckpoint(legacy);
    expect(parsed.joins[0]?.joinInvocationKey).toBe('merge');
    const plan = advance(legacy, [
      {
        kind: 'branch_disposition',
        joinId: 'merge',
        branch: { branchId: 'a', disposition: 'arrived' },
      },
    ]);
    expect(plan.checkpoint.joins[0]).toMatchObject({
      joinInvocationKey: 'merge',
      ledger: [{ branchId: 'a', disposition: 'arrived' }],
      selectedBranchIds: ['a'],
    });
    expect(
      plan.checkpoint.invocations.find(({ nodeId }) => nodeId === 'merge'),
    ).toMatchObject({ status: 'canceled', attemptNumber: 0 });
    expect(plan.attempts).toEqual([]);
    expect(parseCheckpoint(plan.checkpoint)).toEqual(plan.checkpoint);
    expect(current.joins[0]?.ledger).toEqual([
      { branchId: 'a', disposition: 'pending' },
    ]);
  });

  it('does not apply native stopped-Merge suppression to retained checkpoints', () => {
    const native = checkpoint('cancel');
    const retained = {
      ...createCheckpointV2({
        engineVersion: 'test',
        workflowVersionId,
        iterationBudget: 10,
      }),
      runStatus: native.runStatus,
      cancelRequested: true,
      admittedInvocationKeys: native.admittedInvocationKeys,
      invocations: native.invocations,
      joins: native.joins,
    };
    const plan = advance(retained, [
      {
        kind: 'branch_disposition',
        joinId: 'merge',
        branch: { branchId: 'a', disposition: 'arrived' },
      },
    ]);
    expect(plan.checkpoint.joins[0]?.selectedBranchIds).toEqual(['a']);
    expect(plan.attempts).toEqual([]);
  });

  it.each([
    { branchPath: [{ nodeId: 'outer', outputPort: 'other' }] },
    { iterationPath: [{ loopNodeId: 'loop', ordinal: 3 }] },
  ])(
    'does not use a successful Parallel from another scope as stopped-Merge authority %#',
    (scope) => {
      const current = checkpoint('cancel');
      const plan = advance(
        {
          ...current,
          invocations: current.invocations.map((entry) =>
            entry.nodeId === 'parallel'
              ? { ...entry, ...scope, invocationKey: key('parallel', scope) }
              : entry,
          ),
          admittedInvocationKeys: [key('parallel', scope), key('branch')],
        },
        [
          {
            kind: 'branch_disposition',
            joinId: 'merge',
            branch: { branchId: 'a', disposition: 'arrived' },
          },
        ],
      );
      expect(plan.checkpoint.joins[0]?.selectedBranchIds).toEqual(['a']);
      expect(plan.attempts).toEqual([]);
    },
  );

  it.each([{ attemptNumber: 1 }, { attemptNumber: 1, output }])(
    'preserves ordinary settlement for a previously started Merge %#',
    (physical) => {
      const current = checkpoint('cancel');
      const plan = advance(
        {
          ...current,
          invocations: current.invocations.map((entry) =>
            entry.nodeId === 'merge' ? { ...entry, ...physical } : entry,
          ),
        },
        [
          {
            kind: 'branch_disposition',
            joinId: 'merge',
            branch: { branchId: 'a', disposition: 'arrived' },
          },
        ],
      );
      expect(plan.checkpoint.joins[0]?.selectedBranchIds).toEqual(['a']);
      expect(
        plan.checkpoint.invocations.find(({ nodeId }) => nodeId === 'merge'),
      ).toMatchObject(physical);
      expect(plan.attempts).toEqual([]);
    },
  );
});
