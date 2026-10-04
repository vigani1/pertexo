import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/execution';
import {
  advanceWorkflow,
  buildWorkflowExecutableV3,
  createWorkflowCheckpointV3,
  parseWorkflowCheckpointV3,
  type CompiledWorkflowExecutableV3,
  type WorkflowCheckpointV3,
  type WorkflowCallStateV1,
} from '@pertexo/workflow-engine';
import {
  graph,
  RUN_ID,
  VERSION_ID,
} from './support/execution-engine.fixture.js';
import {
  id,
  occurredAt,
  nativeRelease,
  physicalRows,
  projection,
  reconciliationFixture,
  settleJoin,
} from './support/native-reconciliation.fixture.js';

const advanceInput = (executable: CompiledWorkflowExecutableV3) => ({
  executable,
  runId: RUN_ID,
  workflowVersionId: VERSION_ID,
  occurredAt,
  maximumAdmissions: 1,
  signal: new AbortController().signal,
});
async function started(executable: CompiledWorkflowExecutableV3) {
  const input = advanceInput(executable);
  const initial = await advanceWorkflow({
    ...input,
    checkpoint: createWorkflowCheckpointV3({
      engineVersion: 'test',
      workflowVersionId: VERSION_ID,
      iterationBudget: 10,
    }),
    observations: [],
  });
  const manual = initial.attempts[0];
  if (manual === undefined) throw new Error('Manual attempt missing');
  return advanceWorkflow({
    ...input,
    checkpoint: initial.checkpoint,
    observations: [
      {
        kind: 'outcome',
        sequence: initial.checkpoint.nextEventSequence,
        occurredAt,
        invocationKey: manual.invocationKey,
        attemptNumber: 1,
        attemptId: id(10),
        status: 'succeeded',
        output: { kind: 'inline', attemptId: id(10) },
      },
    ],
  });
}
function stopped(
  checkpoint: WorkflowCheckpointV3,
  status: 'canceled' | 'timed_out',
) {
  return status === 'canceled'
    ? {
        observations: [
          {
            kind: 'cancel_requested',
            sequence: checkpoint.nextEventSequence,
            occurredAt,
          },
        ],
        facts: [
          {
            sequence: checkpoint.nextEventSequence,
            type: 'run.cancel_requested',
            created_at: new Date(occurredAt),
            payload: { schemaVersion: 1 },
          },
        ],
      }
    : { observations: [{ kind: 'deadline_expired', occurredAt }], facts: [] };
}
function parallelGraph(policy: 'all' | 'any') {
  const manual = graph().nodes[0];
  if (manual === undefined) throw new Error('Manual definition missing');
  const set = { ...manual, definition: { key: 'core.set', version: 1 } };
  return {
    schemaVersion: 2,
    settings: {},
    nodes: [
      manual,
      {
        ...manual,
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        config: {
          branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
          maxConcurrency: 1,
        },
      },
      { ...set, id: 'left' },
      { ...set, id: 'right' },
      {
        ...manual,
        id: 'merge',
        definition: { key: 'core.merge', version: 1 },
        config: { parallelNodeId: 'parallel', policy: { kind: policy } },
      },
    ],
    edges: [
      {
        id: 'start',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'parallel', port: 'in' },
      },
      ...(['left', 'right'] as const).flatMap((nodeId, index) => [
        {
          id: nodeId,
          source: { nodeId: 'parallel', port: `branch-0${String(index + 1)}` },
          target: { nodeId, port: 'in' },
        },
        {
          id: `join-${nodeId}`,
          source: { nodeId, port: 'out' },
          target: { nodeId: 'merge', port: `branch-0${String(index + 1)}` },
        },
      ]),
    ],
  };
}

it.each(
  (['canceled', 'timed_out'] as const).flatMap((status) =>
    (['succeeded', 'failed', 'outcome_unknown'] as const).map((outcome) => ({
      status,
      outcome,
    })),
  ),
)(
  'actual handler/engine/commit preserves an active Parallel join under $status through branch $outcome settlement and exact replay',
  async ({ status, outcome }) => {
    const executable = buildWorkflowExecutableV3({
      graph: parallelGraph(outcome === 'succeeded' ? 'any' : 'all'),
      release: nativeRelease,
    });
    const control = await started(executable);
    const parallel = control.attempts[0];
    if (parallel === undefined) throw new Error('Parallel attempt missing');
    const identity = {
      sequence: control.checkpoint.nextEventSequence,
      attemptId: id(11),
      invocationKey: parallel.invocationKey,
    };
    const value = { branchIds: ['branch-01', 'branch-02'] };
    const active = await advanceWorkflow({
      ...advanceInput(executable),
      checkpoint: control.checkpoint,
      observations: [
        {
          ...identity,
          kind: 'outcome',
          attemptNumber: 1,
          occurredAt,
          status: 'succeeded',
          output: { kind: 'inline', attemptId: id(11) },
        },
      ],
      completedOutputs: [{ ...identity, value }],
    });
    const checkpoint = active.checkpoint as WorkflowCheckpointV3;
    expect(checkpoint.joins).toHaveLength(1);
    expect(active.attempts).toHaveLength(1);
    const physical = physicalRows(
      checkpoint,
      new Map<string, unknown>([
        ['manual', {}],
        ['parallel', value],
      ]),
    );
    const running = physical.find(
      ({ node_id, node_status }) =>
        node_id === 'left' && node_status === 'running',
    );
    if (!running?.attempt_id) throw new Error('Running left branch missing');
    const fixture = reconciliationFixture({
      executable,
      checkpoint,
      status,
      physical,
      ...stopped(checkpoint, status),
    });
    await expect(fixture.handle()).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(fixture.checkpoint.runStatus).toBe('running');
    expect(
      fixture.checkpoint.joins.map(({ joinId, joinInvocationKey }) => ({
        joinId,
        joinInvocationKey,
      })),
    ).toEqual(
      checkpoint.joins.map(({ joinId, joinInvocationKey }) => ({
        joinId,
        joinInvocationKey,
      })),
    );
    expect(
      fixture.checkpoint.joins[0]?.ledger.find(
        ({ branchId }) => branchId === 'branch-01',
      ),
    ).toEqual(
      checkpoint.joins[0]?.ledger.find(
        ({ branchId }) => branchId === 'branch-01',
      ),
    );
    expect(fixture.plans[0]?.attempts).toEqual([]);
    expect(fixture.plans[0]?.nodeRunAdmissions).toEqual([]);
    expect(fixture.checkpoint.remainingIterationBudget).toBe(10);
    expect(fixture.demand).not.toHaveBeenCalled();
    const writes = fixture.statements.length;
    await expect(fixture.handle(1)).resolves.toMatchObject({
      kind: 'already_committed',
    });
    expect(
      fixture.statements
        .slice(writes)
        .some(({ sql }) => sql.startsWith('update app.node_runs')),
    ).toBe(false);

    // Actual physical terminal truth arrives later; the stop alone cannot manufacture it.
    running.node_status = outcome;
    running.attempt_status = outcome;
    const output =
      outcome === 'succeeded'
        ? { kind: 'inline' as const, attemptId: running.attempt_id }
        : undefined;
    if (output !== undefined) {
      running.node_output_ref = {
        schemaVersion: 1,
        kind: 'inline',
        value: { result: 'done' },
      };
      running.attempt_output_ref = running.node_output_ref;
    }
    const sequence = fixture.checkpoint.nextEventSequence;
    const observations = [
      {
        kind: 'outcome',
        sequence,
        occurredAt,
        invocationKey: running.invocation_key,
        attemptId: running.attempt_id,
        attemptNumber: 1,
        status: outcome,
        ...(output === undefined ? {} : { output }),
      },
    ];
    if (outcome === 'outcome_unknown') {
      for (const corruption of [
        'no-control',
        'started-merge',
        'merge-output',
        'scope',
      ] as const) {
        const corrupted = {
          ...fixture.checkpoint,
          ...(corruption === 'no-control'
            ? { cancelRequested: false, deadlineExpired: false }
            : {}),
          invocations: fixture.checkpoint.invocations.map((entry) =>
            entry.nodeId !== 'merge'
              ? entry
              : {
                  ...entry,
                  ...(corruption === 'started-merge'
                    ? { attemptNumber: 1 }
                    : {}),
                  ...(corruption === 'merge-output'
                    ? { output: { kind: 'inline' as const, attemptId: id(99) } }
                    : {}),
                  ...(corruption === 'scope'
                    ? {
                        branchPath: [
                          { nodeId: 'parallel', outputPort: 'branch-01' },
                        ],
                      }
                    : {}),
                },
          ),
        };
        await expect(
          advanceWorkflow({
            ...advanceInput(executable),
            checkpoint: corrupted,
            observations,
          }),
        ).rejects.toMatchObject({ code: 'checkpoint_invalid' });
      }
    }
    fixture.next({
      callFacts: [],
      observations,
      facts: [
        {
          sequence,
          type: `node.${outcome}`,
          created_at: new Date(occurredAt),
          payload: {
            schemaVersion: 1,
            nodeId: 'left',
            nodeRunId: running.node_run_id,
            attemptId: running.attempt_id,
            invocationKey: running.invocation_key,
            attemptNumber: 1,
          },
        },
      ],
    });
    await expect(fixture.handle()).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(fixture.checkpoint.runStatus).toBe(
      outcome === 'outcome_unknown' ? 'outcome_unknown' : status,
    );
    expect(
      fixture.checkpoint.joins[0]?.ledger.find(
        ({ branchId }) => branchId === 'branch-01',
      )?.disposition,
    ).toBe(outcome === 'succeeded' ? 'arrived' : 'failed');
    expect(fixture.checkpoint.joins[0]?.selectedBranchIds).toBeUndefined();
    expect(fixture.checkpoint.joins[0]?.unsatisfiedReasonCode).toBeUndefined();
    const join = fixture.checkpoint.joins[0];
    if (join === undefined) throw new Error('Retained join missing');
    expect(settleJoin(join).kind).toBe(
      outcome === 'succeeded' ? 'satisfied' : 'unsatisfied',
    );
    expect(
      parseWorkflowCheckpointV3(JSON.parse(JSON.stringify(fixture.checkpoint))),
    ).toEqual(fixture.checkpoint);
    expect(
      fixture.checkpoint.invocations.find(({ nodeId }) => nodeId === 'merge'),
    ).toMatchObject({ status: 'canceled', attemptNumber: 0 });
    expect(fixture.plans.at(-1)?.attempts).toEqual([]);
    expect(fixture.checkpoint.remainingIterationBudget).toBe(10);
    await expect(fixture.handle(1)).resolves.toMatchObject({
      kind: 'already_committed',
    });
    expect(fixture.demand).not.toHaveBeenCalled();
    const stoppedEvents = fixture.statements
      .filter(
        ({ sql }) =>
          sql.includes('insert into app.run_events') &&
          !sql.includes('returning sequence'),
      )
      .flatMap(
        ({ values }) =>
          JSON.parse(String(values[2])) as { type: string; payload: string }[],
      )
      .filter(({ type }) => type === 'node.canceled');
    expect(stoppedEvents).toHaveLength(2);
    for (const event of stoppedEvents) {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      expect(payload).toMatchObject({
        schemaVersion: 1,
        attemptNumber: 0,
      });
      expect(typeof payload.nodeRunId).toBe('string');
      expect(payload.attemptId).toBeUndefined();
    }
  },
);

it.each(['canceled', 'timed_out'] as const)(
  'actual handler/engine/commit keeps an admitted child waiting under %s, persists real child control/event/outbox once, then retains unknown outcome and replay',
  async (status) => {
    const base = graph();
    const objectType = {
      type: 'object' as const,
      properties: { name: { type: 'string' as const } },
      required: ['name'],
    };
    const callable = {
      schemaVersion: 1 as const,
      input: objectType,
      result: objectType,
      resultSelector: { kind: 'run_input' as const, path: '$' },
    };
    const callee = buildWorkflowExecutableV3({
      graph: { ...base, schemaVersion: 2, callable },
      release: nativeRelease,
    });
    const pin = {
      workflowId: id(30),
      versionId: id(31),
      checksum: callee.checksum,
      callableContractIdentity: workflowCallableContractIdentityV1(callable),
    };
    const manual = base.nodes[0];
    if (manual === undefined) throw new Error('Manual missing');
    const executable = buildWorkflowExecutableV3({
      graph: {
        schemaVersion: 2,
        settings: {},
        nodes: [
          manual,
          {
            ...manual,
            id: 'call',
            definition: { key: 'core.workflow_call', version: 1 },
            config: pin,
            inputMappings: { name: { kind: 'literal', value: 'input' } },
          },
        ],
        edges: [
          {
            id: 'call',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'call', port: 'in' },
          },
        ],
      },
      release: nativeRelease,
    });
    const start = await started(executable);
    const callAttempt = start.attempts[0];
    if (callAttempt === undefined) throw new Error('Call missing');
    const reference = { kind: 'inline' as const, attemptId: id(12) };
    const declarations = new Map([[pin.versionId, callable]]);
    const waiting = await advanceWorkflow({
      ...advanceInput(executable),
      checkpoint: start.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: start.checkpoint.nextEventSequence,
          occurredAt,
          invocationKey: callAttempt.invocationKey,
          attemptNumber: 1,
          attemptId: id(12),
          status: 'succeeded',
          output: reference,
        },
      ],
      workflowCalls: {
        declarations: [
          {
            invocationKey: callAttempt.invocationKey,
            nodeId: 'call',
            declarationAttemptId: id(12),
            input: reference,
            inputChecksum: createHash('sha256')
              .update('{"name":"input"}')
              .digest('hex'),
            value: { name: 'input' },
          },
        ],
        facts: [],
        calleeDeclarations: declarations,
      },
    });
    const retained = (waiting.checkpoint as WorkflowCheckpointV3).calls[0];
    if (retained === undefined) throw new Error('Call journal missing');
    const admitted: WorkflowCallStateV1 = {
      ...retained,
      status: 'admitted',
      childRunId: id(32),
    };
    const active = await advanceWorkflow({
      ...advanceInput(executable),
      checkpoint: waiting.checkpoint,
      observations: [],
      workflowCalls: {
        declarations: [],
        facts: [admitted],
        calleeDeclarations: declarations,
      },
    });
    const checkpoint = active.checkpoint as WorkflowCheckpointV3;
    const physical = physicalRows(
      checkpoint,
      new Map([
        ['manual', {}],
        ['call', { name: 'input' }],
      ]),
    );
    const fixture = reconciliationFixture({
      executable,
      checkpoint,
      status,
      physical,
      callFacts: [admitted],
      callee: projection(callee, pin.versionId),
      ...stopped(checkpoint, status),
    });
    await expect(fixture.handle()).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(fixture.checkpoint.runStatus).toBe('waiting');
    expect(fixture.checkpoint.calls).toEqual([admitted]);
    expect(fixture.plans[0]?.workflowCalls).toEqual({
      declarations: [],
      cancelChildren: [
        {
          childRunId: id(32),
          reason:
            status === 'canceled' ? 'cancel_requested' : 'deadline_expired',
        },
      ],
    });
    expect(fixture.plans[0]?.attempts).toEqual([]);
    expect(fixture.demand).not.toHaveBeenCalled();
    const childOutboxes = () =>
      fixture.statements.filter(({ sql }) =>
        sql.includes('insert into "app"."outbox_events"'),
      );
    const childEvents = () =>
      fixture.statements.filter(
        ({ sql }) =>
          sql.includes('insert into app.run_events') &&
          sql.includes('returning sequence'),
      );
    expect(childOutboxes()).toHaveLength(1);
    const outbox = childOutboxes()[0];
    if (outbox === undefined) throw new Error('Child outbox missing');
    expect(outbox.values).toContain(id(32));
    const serializedPayload = outbox.values.find(
      (value) => typeof value === 'string' && value.startsWith('{'),
    );
    if (typeof serializedPayload !== 'string')
      throw new Error('Child outbox payload missing');
    const childPayload = JSON.parse(serializedPayload) as Record<
      string,
      unknown
    >;
    expect(childPayload).toMatchObject({
      schemaVersion: 1,
      runId: id(32),
    });
    expect(typeof childPayload.outboxEventId).toBe('string');
    expect(outbox.values).toContain(
      canonicalOutboxPayloadChecksum(childPayload),
    );
    expect(childEvents()).toHaveLength(status === 'canceled' ? 1 : 0);
    const childEvent = childEvents()[0];
    if (childEvent !== undefined)
      expect(childEvent.values).toContain('run.cancel_requested');
    expect(fixture.childRequests.size).toBe(1);
    await expect(fixture.handle(1)).resolves.toMatchObject({
      kind: 'already_committed',
    });
    expect(childOutboxes()).toHaveLength(1);
    expect(childEvents()).toHaveLength(status === 'canceled' ? 1 : 0);
    const unknown: WorkflowCallStateV1 = {
      ...admitted,
      status: 'settled',
      childStatus: 'outcome_unknown',
    };
    fixture.next({ observations: [], facts: [], callFacts: [unknown] });
    await expect(fixture.handle()).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(fixture.checkpoint.runStatus).toBe('outcome_unknown');
    expect(fixture.checkpoint.calls).toEqual([unknown]);
    expect(
      parseWorkflowCheckpointV3(JSON.parse(JSON.stringify(fixture.checkpoint))),
    ).toEqual(fixture.checkpoint);
    expect(fixture.plans.at(-1)?.workflowCalls).toEqual({
      declarations: [],
      cancelChildren: [],
    });
    const projectionWrites = fixture.statements.filter(({ sql }) =>
      sql.startsWith('update app.node_runs node'),
    );
    expect(projectionWrites).toHaveLength(1);
    expect(projectionWrites[0]?.values[3]).toBe('outcome_unknown');
    expect(
      fixture.statements.some(({ sql }) =>
        sql.startsWith('update app.node_attempts'),
      ),
    ).toBe(false);
    expect(physical.find(({ node_id }) => node_id === 'call')).toMatchObject({
      attempt_status: 'succeeded',
      attempt_output_ref: {
        schemaVersion: 1,
        kind: 'inline',
        value: { name: 'input' },
      },
      node_output_ref: null,
    });
    await expect(fixture.handle(1)).resolves.toMatchObject({
      kind: 'already_committed',
    });
    expect(childOutboxes()).toHaveLength(1);
    expect(
      fixture.statements.filter(({ sql }) =>
        sql.startsWith('update app.node_runs node'),
      ),
    ).toHaveLength(1);
    expect(fixture.checkpoint.remainingIterationBudget).toBe(10);
    expect(fixture.demand).not.toHaveBeenCalled();
  },
);
