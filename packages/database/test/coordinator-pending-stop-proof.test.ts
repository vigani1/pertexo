import type { PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { encodeWorkflowInvocationKeyV2 } from '@pertexo/workflow-model/invocation-key-v2';
import { lockNativePendingStops } from '../src/execution/coordinator/coordinator-pending-stop-proof.js';
import {
  validateStatusTransitions,
  type ParsedTransitionPlan,
} from '../src/execution/coordinator/coordinator-run-store-plan.js';
import {
  parseCoordinatorCheckpoint,
  type CoordinatorCheckpoint,
} from '../src/execution/coordinator/coordinator-checkpoint.js';
import {
  nativeCoordinatorControlFixture,
  nativeControlId,
} from './support/coordinator-native-control.fixture.js';

function fixture(deadline = false) {
  const { material, plan: base } = nativeCoordinatorControlFixture();
  const branchPath = [{ nodeId: 'parallel', outputPort: 'branch-01' }];
  const key = encodeWorkflowInvocationKeyV2({
    workflowVersionId: material.checkpoint.workflowVersionId,
    nodeId: 'body',
    branchPath: ['parallel:branch-01'],
  });
  const invocation = {
    invocationKey: key,
    nodeId: 'body',
    status: 'pending' as const,
    attemptNumber: 0,
    branchPath,
  };
  const current: Extract<CoordinatorCheckpoint, { schemaVersion: 3 }> = {
    ...material.checkpoint,
    runStatus: 'running',
    invocations: [invocation],
    admittedInvocationKeys: [],
    readySet: [],
  };
  const plan: ParsedTransitionPlan = {
    ...base,
    expectedRevision: current.revision,
    expectedNextEventSequence: current.nextEventSequence,
    consumedThroughEventSequence: current.nextEventSequence - 1,
    checkpoint: {
      ...current,
      revision: current.revision + 1,
      runStatus: deadline ? 'timed_out' : 'canceled',
      cancelRequested: !deadline,
      deadlineExpired: deadline,
      nextEventSequence: current.nextEventSequence + 2,
      invocations: [{ ...invocation, status: 'canceled' }],
    },
    events: [
      {
        schemaVersion: 1,
        sequence: current.nextEventSequence,
        name: 'node.canceled',
        occurredAt: '2026-10-04T00:00:00.000Z',
        invocationKey: key,
        nodeId: 'body',
        attemptNumber: 0,
      },
      {
        schemaVersion: 1,
        sequence: current.nextEventSequence + 1,
        name: deadline ? 'run.timed_out' : 'run.canceled',
        occurredAt: '2026-10-04T00:00:00.000Z',
      },
    ],
    attempts: [],
    nodeRunAdmissions: [],
  };
  const row: Record<string, unknown> = {
    invocation_key: key,
    node_id: 'body',
    status: 'pending',
    branch_context: { branchPath },
    current_attempt_id: null,
    current_attempt_number: null,
    output_ref: null,
    attempt_count: 0,
  };
  const query = vi.fn().mockResolvedValue({ rows: [row] });
  const input = {
    workspaceId: nativeControlId(1),
    runId: nativeControlId(2),
    executable: material.executable,
    current,
    plan,
    canceled: !deadline,
    deadlineExpired: deadline,
  };
  return { input, row, query, client: { query } as unknown as PoolClient, key };
}
it.each([false, true])(
  'requires locked exact never-started native physical state for deadline=%s',
  async (deadline) => {
    const { input, client, query, key } = fixture(deadline);
    const proven = await lockNativePendingStops(client, input);
    expect(proven).toEqual(new Set([key]));
    expect(query.mock.calls[0]?.[0]).toContain('for update of node');
    expect(query.mock.calls[0]?.[1]).toEqual([
      input.workspaceId,
      input.runId,
      [key],
    ]);
    expect(() => {
      validateStatusTransitions(input.current, input.plan, []);
    }).toThrow();
    expect(() => {
      validateStatusTransitions(
        input.current,
        input.plan,
        [],
        new Set(),
        [],
        new Set(),
        proven,
      );
    }).not.toThrow();
  },
);

it.each([
  'caller-control',
  'wrong-status',
  'attempt',
  'output',
  'scope',
  'admission',
  'new-attempt',
  'debit',
  'event',
  'node-id',
  'physical-status',
  'physical-attempt',
  'physical-count',
  'physical-output',
  'physical-scope',
  'physical-key',
  'missing-row',
  'duplicate-row',
  'pin',
] as const)(
  'fails closed for %s instead of authorizing a proposed pending stop',
  async (kind) => {
    const { input, client, query, row } = fixture();
    const next = input.plan.checkpoint.invocations[0];
    const before = input.current.invocations[0];
    if (next === undefined || before === undefined)
      throw new Error('fixture invocation missing');
    if (kind === 'caller-control') input.canceled = false;
    if (kind === 'wrong-status') next.status = 'failed';
    if (kind === 'attempt') before.attemptNumber = 1;
    if (kind === 'output')
      before.output = { kind: 'inline', attemptId: nativeControlId(6) };
    if (kind === 'scope' && 'branchPath' in next)
      next.branchPath = [{ nodeId: 'parallel', outputPort: 'branch-02' }];
    if (kind === 'admission')
      input.plan.nodeRunAdmissions = [
        {
          nodeId: 'body',
          invocationKey: next.invocationKey,
          sideEffectClass: 'safe',
        },
      ];
    if (kind === 'new-attempt')
      input.plan.attempts = [
        {
          nodeId: 'body',
          invocationKey: next.invocationKey,
          sideEffectClass: 'safe',
          attemptNumber: 1,
          admissionKind: 'execute',
        },
      ];
    if (kind === 'debit')
      input.plan = {
        ...input.plan,
        checkpoint: {
          ...input.plan.checkpoint,
          remainingIterationBudget:
            input.plan.checkpoint.remainingIterationBudget - 1,
        },
      };
    if (kind === 'event') input.plan.events = [];
    if (kind === 'node-id') next.nodeId = 'invented';
    if (kind === 'physical-status') row.status = 'ready';
    if (kind === 'physical-attempt')
      row.current_attempt_id = nativeControlId(6);
    if (kind === 'physical-count') row.attempt_count = 1;
    if (kind === 'physical-output')
      row.output_ref = { schemaVersion: 1, kind: 'inline', value: {} };
    if (kind === 'physical-scope') row.branch_context = {};
    if (kind === 'physical-key') row.invocation_key = 'wrong';
    if (kind === 'missing-row') query.mockResolvedValue({ rows: [] });
    if (kind === 'duplicate-row') query.mockResolvedValue({ rows: [row, row] });
    if (kind === 'pin')
      input.executable = {
        schemaVersion: 3,
        graph: { nodes: [] },
      };
    await expect(lockNativePendingStops(client, input)).rejects.toThrow();
  },
);
it('does not grant retained checkpoint pending-stop authority', async () => {
  const { input, client } = fixture();
  const { calls: _calls, ...retained } = input.current;
  await expect(
    lockNativePendingStops(client, {
      ...input,
      current: parseCoordinatorCheckpoint({ ...retained, schemaVersion: 2 }, 2),
    }),
  ).resolves.toEqual(new Set());
});
