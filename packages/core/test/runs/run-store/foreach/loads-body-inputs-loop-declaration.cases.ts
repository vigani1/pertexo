import { it, expect } from 'vitest';
import {
  asRuntime,
  createHash,
  insertRun,
  nodeAttemptStore,
  randomUUID,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';
import { NodeAttemptStateCorruptError } from '../../../../src/attempts/index.js';

export function registerLoadsBodyInputsLoopDeclaration(): void {
  it('loads body inputs and the loop declaration for an ordinal-scoped attempt', async () => {
    const controlKey = `${versionA}|loop|b:|i:`;
    const first0Key = `${versionA}|body-first|b:|i:loop%3A0`;
    const first1Key = `${versionA}|body-first|b:|i:loop%3A1`;
    const sink1Key = `${versionA}|body-sink|b:|i:loop%3A1`;
    const declarationAttemptId = randomUUID();
    const declarationNodeRunId = randomUUID();
    const first0AttemptId = randomUUID();
    const first0NodeRunId = randomUUID();
    const first1AttemptId = randomUUID();
    const first1NodeRunId = randomUUID();
    const sinkAttemptId = randomUUID();
    const sinkNodeRunId = randomUUID();
    const items = ['ordinal-zero', 'ordinal-one'];
    const collectionChecksum = createHash('sha256')
      .update(JSON.stringify(items))
      .digest('hex');
    const declarationOutput = {
      kind: 'inline',
      value: { items, iterationCount: 2 },
    };
    const inline = (value: unknown) => ({
      kind: 'inline',
      value,
    });
    const schedulerState = {
      workflowVersionId: versionA,
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 2,
      readySet: [],
      admittedInvocationKeys: [controlKey, first0Key, first1Key, sink1Key],
      invocations: [
        {
          invocationKey: controlKey,
          nodeId: 'loop',
          status: 'waiting',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: declarationAttemptId },
          branchPath: [],
          iterationPath: [],
        },
        {
          invocationKey: first0Key,
          nodeId: 'body-first',
          status: 'succeeded',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: first0AttemptId },
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
        {
          invocationKey: first1Key,
          nodeId: 'body-first',
          status: 'succeeded',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: first1AttemptId },
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
        },
        {
          invocationKey: sink1Key,
          nodeId: 'body-sink',
          status: 'running',
          attemptNumber: 1,
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
        },
      ],
      joins: [],
      loops: [
        {
          controlInvocationKey: controlKey,
          loopId: 'loop',
          branchPath: [],
          iterationPath: [],
          bodyRootNodeIds: ['body-first'],
          bodySinkNodeId: 'body-sink',
          collection: { kind: 'inline', attemptId: declarationAttemptId },
          collectionChecksum,
          collectionSize: 2,
          maxConcurrency: 2,
          maxIterations: 2,
          nextOrdinal: 2,
          activeOrdinals: [0, 1],
          completedPrefix: 0,
          terminalOrdinals: [],
        },
      ],
      remainingIterationBudget: 0,
      initialIterationBudget: 2,
      branchSelections: [],
      cancelRequested: false,
      deadlineExpired: false,
    } as const;
    const runId = await insertRun({
      schedulerState,
      status: 'running',
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      for (const row of [
        {
          nodeRunId: declarationNodeRunId,
          attemptId: declarationAttemptId,
          nodeId: 'loop',
          invocationKey: controlKey,
          branchContext: { branchPath: [], iterationPath: [] },
          nodeStatus: 'waiting',
          attemptStatus: 'succeeded',
          output: declarationOutput,
          controlKind: 'for_each_barrier',
        },
        {
          nodeRunId: first0NodeRunId,
          attemptId: first0AttemptId,
          nodeId: 'body-first',
          invocationKey: first0Key,
          branchContext: {
            branchPath: [],
            iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
          },
          nodeStatus: 'succeeded',
          attemptStatus: 'succeeded',
          output: inline({ value: 'ordinal-zero' }),
          controlKind: null,
        },
        {
          nodeRunId: first1NodeRunId,
          attemptId: first1AttemptId,
          nodeId: 'body-first',
          invocationKey: first1Key,
          branchContext: {
            branchPath: [],
            iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
          },
          nodeStatus: 'succeeded',
          attemptStatus: 'succeeded',
          output: inline({ value: 'ordinal-one' }),
          controlKind: null,
        },
        {
          nodeRunId: sinkNodeRunId,
          attemptId: sinkAttemptId,
          nodeId: 'body-sink',
          invocationKey: sink1Key,
          branchContext: {
            branchPath: [],
            iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
          },
          nodeStatus: 'running',
          attemptStatus: 'running',
          output: null,
          controlKind: null,
        },
      ]) {
        await client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,control_kind,side_effect_class,
               current_attempt_id,current_attempt_number,output_ref
             ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'safe',$9,1,$10::jsonb)`,
          [
            row.nodeRunId,
            workspaceA,
            runId,
            row.nodeId,
            row.invocationKey,
            JSON.stringify(row.branchContext),
            row.nodeStatus,
            row.controlKind,
            row.attemptId,
            row.output === null ? null : JSON.stringify(row.output),
          ],
        );
        await client.query(
          `insert into app.node_attempts (
               id,workspace_id,node_run_id,attempt_number,status,
               side_effect_class,lease_owner,lease_expires_at,fence_token,output_ref
             ) values ($1,$2,$3,1,$4::varchar,'safe',$5,
                       case when $4::varchar='running' then clock_timestamp()+interval '1 hour' else null end,
                       case when $4::varchar='running' then 1 else 0 end,$6::jsonb)`,
          [
            row.attemptId,
            workspaceA,
            row.nodeRunId,
            row.attemptStatus,
            row.attemptStatus === 'running' ? 'attempt-worker-loop' : null,
            row.output === null ? null : JSON.stringify(row.output),
          ],
        );
      }
    });
    const lease = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      nodeRunId: sinkNodeRunId,
      attemptId: sinkAttemptId,
      attemptNumber: 1,
      admissionKind: 'execute' as const,
      invocationKey: sink1Key,
      nodeId: 'body-sink',
      iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
      sideEffectClass: 'safe' as const,
      workerId: 'attempt-worker-loop',
      fenceToken: 1,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
      delivery: {
        outboxEventId: randomUUID(),
        payloadChecksum: 'a'.repeat(64),
      },
    };
    const load = (upstreamInvocationKey = first1Key) =>
      nodeAttemptStore.loadInputs({
        lease,
        upstreamNodeOutputs: [
          {
            nodeId: 'body-first',
            invocationKey: upstreamInvocationKey,
          },
        ],
        signal: new AbortController().signal,
      });

    await expect(load()).resolves.toMatchObject({
      completedNodeOutputs: [
        {
          nodeId: 'body-first',
          invocationKey: first1Key,
          value: { value: 'ordinal-one' },
        },
      ],
      checkpoint: schedulerState,
    });
    // The loop item itself is projected by execution from these two reads.
    await expect(
      nodeAttemptStore.readLoopDeclaration({
        lease,
        controlInvocationKey: controlKey,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      nodeId: 'loop',
      attemptId: declarationAttemptId,
      output: { items, iterationCount: 2 },
    });
    // Each pass's result is read back by key once the loop is done.
    const signal = new AbortController().signal;
    const outcomes = await nodeAttemptStore.listNodeOutcomes({
      lease,
      nodeId: 'body-first',
      signal,
    });
    expect(
      outcomes
        .map(({ invocationKey, status }) => ({ invocationKey, status }))
        .sort((left, right) =>
          left.invocationKey.localeCompare(right.invocationKey),
        ),
    ).toEqual([
      { invocationKey: first0Key, status: 'succeeded' },
      { invocationKey: first1Key, status: 'succeeded' },
    ]);
    expect(outcomes.every(({ outputBytes }) => outputBytes > 0)).toBe(true);
    await expect(
      nodeAttemptStore.listNodeOutcomes({ lease, nodeId: 'body-sink', signal }),
    ).resolves.toEqual([]);
    expect(
      [
        ...(await nodeAttemptStore.readNodeOutputs({
          lease,
          invocationKeys: [first1Key, first0Key],
          signal,
        })),
      ].sort((left, right) =>
        left.invocationKey.localeCompare(right.invocationKey),
      ),
    ).toEqual([
      { invocationKey: first0Key, output: { value: 'ordinal-zero' } },
      { invocationKey: first1Key, output: { value: 'ordinal-one' } },
    ]);
    await expect(
      nodeAttemptStore.readNodeOutputs({
        lease,
        invocationKeys: [first0Key, sink1Key],
        signal,
      }),
    ).rejects.toThrow(NodeAttemptStateCorruptError);
  });
}
