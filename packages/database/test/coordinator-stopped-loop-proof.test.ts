import type { PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { encodeWorkflowInvocationKeyV2 } from '@pertexo/workflow-model/invocation-key-v2';
import {
  nativeCoordinatorControlFixture,
  nativeControlId,
} from './support/coordinator-native-control.fixture.js';
import { deriveStoppedForEachDeclarations } from '../src/execution/coordinator/coordinator-stopped-loop-proof.js';
import { lockCoordinatorControlSettlements } from '../src/execution/coordinator/coordinator-control-settlements.js';
import { validateStatusTransitions } from '../src/execution/coordinator/coordinator-run-store-plan.js';
import { validateCheckpointOutputOwnership } from '../src/execution/coordinator/coordinator-checkpoint-output-ownership.js';
import { persistStoppedForEachDeclarations } from '../src/execution/coordinator/coordinator-run-store-settlement.js';
import {
  mapEvent,
  record,
} from '../src/execution/coordinator/coordinator-run-store-observations.js';
import type { CoordinatorEventRow } from '../src/execution/coordinator/coordinator-run-store-fact-physical-state.js';
import type { ParsedTransitionPlan } from '../src/execution/coordinator/coordinator-run-store-plan.js';
import type { CoordinatorCheckpoint } from '../src/execution/coordinator/coordinator-checkpoint.js';

function fixture(status: 'canceled' | 'timed_out' = 'canceled') {
  const {
    material,
    plan: basePlan,
    source,
  } = nativeCoordinatorControlFixture();
  const key = encodeWorkflowInvocationKeyV2({
    workflowVersionId: material.checkpoint.workflowVersionId,
    nodeId: 'loop',
  });
  const current = {
    ...material.checkpoint,
    invocations: material.checkpoint.invocations.map((invocation) => ({
      ...invocation,
      invocationKey: key,
    })),
    admittedInvocationKeys: [key],
  };
  const plan: ParsedTransitionPlan & {
    checkpoint: Extract<CoordinatorCheckpoint, { schemaVersion: 3 }>;
  } = {
    ...basePlan,
    checkpoint: {
      ...current,
      revision: 5,
      runStatus: status,
      nextEventSequence: 8,
      cancelRequested: status === 'canceled',
      deadlineExpired: status === 'timed_out',
      invocations: current.invocations.map((invocation) => ({
        ...invocation,
        status,
        output: source.output,
      })),
    },
  };
  plan.events = [
    {
      schemaVersion: 1,
      sequence: 6,
      name: `node.${status}`,
      occurredAt: '2026-10-04T00:00:00.000Z',
      invocationKey: key,
      nodeId: 'loop',
      attemptNumber: 1,
    },
    {
      schemaVersion: 1,
      sequence: 7,
      name: `run.${status}`,
      occurredAt: '2026-10-04T00:00:00.000Z',
    },
  ];
  const stored = {
    schemaVersion: 1,
    kind: 'artifact',
    artifactId: nativeControlId(6),
  };
  const fact: CoordinatorEventRow = {
    sequence: 5,
    type: 'node.succeeded',
    created_at: new Date('2026-10-04T00:00:00.000Z'),
    payload: {
      schemaVersion: 1,
      nodeId: 'loop',
      invocationKey: key,
      attemptId: nativeControlId(5),
      nodeRunId: nativeControlId(8),
      attemptNumber: 1,
    },
    attempt_id: nativeControlId(5),
    attempt_number: 1,
    attempt_status: 'succeeded',
    attempt_output_ref: stored,
    node_output_ref: stored,
    executor_failure_kind: null,
    invocation_key: key,
    node_run_id: nativeControlId(8),
    node_id: 'loop',
    current_attempt_id: nativeControlId(5),
    node_status: 'succeeded',
    branch_context: {},
    resume_at: null,
    retry_due_at: null,
    retry_decision: null,
    wait_kind: null,
  };
  return {
    executable: material.executable,
    current,
    plan,
    facts: [fact],
    canceled: status === 'canceled',
    deadlineExpired: status === 'timed_out',
  };
}
it.each(['canceled', 'timed_out'] as const)(
  'derives %s from physical original output and actual controls',
  (status) => {
    const input = fixture(status);
    const proof = deriveStoppedForEachDeclarations(input);
    expect([...proof.values()]).toEqual([
      {
        attemptId: nativeControlId(5),
        nodeId: 'loop',
        attemptNumber: 1,
        status,
      },
    ]);
    validateStatusTransitions(
      input.current,
      input.plan,
      input.facts.map((fact) => ({
        invocationKey: fact.invocation_key,
        observation: record(mapEvent(fact)),
        type: fact.type,
      })),
      new Set(),
      [],
      new Set(proof.keys()),
    );
    expect(() => {
      validateStatusTransitions(
        input.current,
        input.plan,
        input.facts.map((fact) => ({
          invocationKey: fact.invocation_key,
          observation: record(mapEvent(fact)),
          type: fact.type,
        })),
      );
    }).toThrow();
  },
);
it.each([
  'future',
  'old',
  'attempt',
  'status',
  'output',
  'scope',
  'physical-scope',
  'pin',
  'budget',
  'control',
  'event',
  'duplicate',
] as const)('refuses %s drift rather than trusting a terminal plan', (kind) => {
  const input = fixture();
  const fact = input.facts[0];
  const next = input.plan.checkpoint.invocations[0];
  if (fact === undefined || next === undefined)
    throw new Error('missing fixture');
  if (kind === 'future') input.facts = [{ ...fact, sequence: 6 }];
  if (kind === 'old') input.facts = [{ ...fact, sequence: 4 }];
  if (kind === 'attempt')
    input.facts = [{ ...fact, current_attempt_id: nativeControlId(9) }];
  if (kind === 'status') input.facts = [{ ...fact, attempt_status: 'failed' }];
  if (kind === 'physical-scope')
    input.facts = [
      {
        ...fact,
        branch_context: {
          branchPath: [{ nodeId: 'wrong', outputPort: 'true' }],
        },
      },
    ];
  if (kind === 'output')
    input.facts = [
      {
        ...fact,
        node_output_ref: {
          schemaVersion: 1,
          kind: 'artifact',
          artifactId: nativeControlId(9),
        },
      },
    ];
  if (kind === 'scope')
    input.plan = {
      ...input.plan,
      checkpoint: {
        ...input.plan.checkpoint,
        invocations: [
          { ...next, branchPath: [{ nodeId: 'branch', outputPort: 'true' }] },
        ],
      },
    };
  if (kind === 'pin')
    input.executable = { schemaVersion: 3, graph: { nodes: [] } };
  if (kind === 'budget')
    input.plan = {
      ...input.plan,
      checkpoint: { ...input.plan.checkpoint, remainingIterationBudget: 9 },
    };
  if (kind === 'control') input.canceled = false;
  if (kind === 'event') input.plan.events = [];
  if (kind === 'duplicate') input.facts = [fact, fact];
  expect(() => deriveStoppedForEachDeclarations(input)).toThrow();
});
it.each(['canceled', 'timed_out'] as const)(
  'locks fresh %s facts then validates ownership and projects only logical state',
  async (status) => {
    const input = fixture(status);
    const fact = input.facts[0];
    if (fact === undefined) throw new Error('missing fixture');
    const query = vi.fn((sql: string) => {
      if (sql.includes('select executable_schema_version'))
        return Promise.resolve({
          rows: [
            { executable_schema_version: 3, executable_json: input.executable },
          ],
        });
      if (sql.includes('select attempt.id'))
        return Promise.resolve({ rows: [fact] });
      if (sql.includes('select node.invocation_key'))
        return Promise.resolve({ rows: [fact] });
      if (sql.includes('select id from app.artifacts'))
        return Promise.resolve({ rows: [{ id: nativeControlId(6) }] });
      if (sql.includes('update app.node_runs'))
        return Promise.resolve({ rows: [], rowCount: 1 });
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;
    const locked = await lockCoordinatorControlSettlements(
      client,
      {
        workspaceId: nativeControlId(1),
        runId: nativeControlId(2),
        workflowVersionId: input.current.workflowVersionId,
        plan: input.plan,
        delivery: {
          outboxEventId: nativeControlId(10),
          payloadChecksum: 'a'.repeat(64),
        },
      },
      input.current,
      input.facts,
      input.canceled,
      input.deadlineExpired,
    );
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('for update of node,attempt'),
      ),
    ).toBe(true);
    await validateCheckpointOutputOwnership(
      client,
      nativeControlId(1),
      nativeControlId(2),
      input.current,
      input.plan.checkpoint,
      new Set(),
      new Set(locked.stoppedForEachDeclarations.keys()),
    );
    await persistStoppedForEachDeclarations(client, {
      workspaceId: nativeControlId(1),
      runId: nativeControlId(2),
      declarations: locked.stoppedForEachDeclarations,
    });
    const writes = query.mock.calls.filter(([sql]) =>
      sql.includes('update app.node_runs'),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0].split('from app.node_attempts')[0]).not.toContain(
      'output_ref',
    );
    expect(
      query.mock.calls.some(([sql]) => /update app.node_attempts/u.test(sql)),
    ).toBe(false);
  },
);

it('refuses an artifact Parallel physical success even when controls stop value demand', () => {
  const input = fixture();
  input.executable = {
    schemaVersion: 3,
    graph: {
      nodes: [
        {
          id: 'loop',
          definition: { key: 'core.parallel', version: 1 },
          config: {
            branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
            maxConcurrency: 1,
          },
        },
      ],
    },
  };
  expect(() => deriveStoppedForEachDeclarations(input)).toThrow();
});
