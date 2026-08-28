import { describe, it, expect } from 'vitest';

import {
  CoordinatorRunStateCorruptError,
  NodeAttemptStateCorruptError,
  asOwner,
  asRuntime,
  checkpoint,
  createCoordinatorRunStore,
  createDueNodeWakeupScanner,
  createHash,
  databaseUrl,
  insertRun,
  nodeAttemptStore,
  parseDatabaseConfig,
  randomUUID,
  rawStore,
  store,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';

describe('Coordinator For Each persistence invariants', () => {
  it('atomically persists and reloads a scoped For Each barrier and first body admission', async () => {
    const controlKey = `${versionA}|loop|b:|i:`;
    const bodyKey = `${versionA}|body|b:|i:loop%3A0`;
    const controlNodeRunId = randomUUID();
    const controlAttemptId = randomUUID();
    const current = {
      ...checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey: controlKey,
            nodeId: 'loop',
            status: 'running',
            attemptNumber: 1,
            branchPath: [],
            iterationPath: [],
          },
        ],
        admittedInvocationKeys: [controlKey],
      }),
      schemaVersion: 2,
      branchSelections: [],
      initialIterationBudget: 2,
      remainingIterationBudget: 2,
    } as const;
    const runId = await insertRun({
      schedulerState: current,
      status: 'running',
    });
    const storedOutput = {
      schemaVersion: 1,
      kind: 'inline',
      value: { items: ['first', 'second'], iterationCount: 2 },
    };
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
           ) values ($1,$2,$3,'loop',$4,$5::jsonb,'succeeded','safe',$6,1,$7::jsonb)`,
        [
          controlNodeRunId,
          workspaceA,
          runId,
          controlKey,
          JSON.stringify({ branchPath: [], iterationPath: [] }),
          controlAttemptId,
          JSON.stringify(storedOutput),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
           ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
        [
          controlAttemptId,
          workspaceA,
          controlNodeRunId,
          JSON.stringify(storedOutput),
        ],
      );
      await client.query(
        `insert into app.run_events (
             workspace_id,workflow_run_id,sequence,type,payload
           ) values ($1,$2,2,'node.succeeded',$3::jsonb)`,
        [
          workspaceA,
          runId,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId: controlNodeRunId,
            attemptId: controlAttemptId,
          }),
        ],
      );
    });

    const loaded = await store.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({
      kind: 'ready',
      state: {
        completedOutputs: [
          {
            invocationKey: controlKey,
            value: { items: ['first', 'second'], iterationCount: 2 },
          },
        ],
      },
    });

    const next = {
      ...current,
      revision: 1,
      nextEventSequence: 4,
      remainingIterationBudget: 0,
      admittedInvocationKeys: [controlKey, bodyKey],
      invocations: [
        {
          invocationKey: controlKey,
          nodeId: 'loop',
          status: 'waiting',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: controlAttemptId },
          branchPath: [],
          iterationPath: [],
        },
        {
          invocationKey: bodyKey,
          nodeId: 'body',
          status: 'running',
          attemptNumber: 1,
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
      ],
      loops: [
        {
          controlInvocationKey: controlKey,
          loopId: 'loop',
          branchPath: [],
          iterationPath: [],
          bodyRootNodeIds: ['body'],
          bodySinkNodeId: 'body',
          collection: { kind: 'inline', attemptId: controlAttemptId },
          collectionChecksum: 'c'.repeat(64),
          collectionSize: 2,
          maxConcurrency: 1,
          maxIterations: 2,
          nextOrdinal: 1,
          activeOrdinals: [0],
          terminalOrdinals: [],
        },
      ],
    } as const;
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 2,
      checkpoint: next,
      events: [
        {
          schemaVersion: 1,
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-08-24T00:00:00.000Z',
          invocationKey: bodyKey,
          nodeId: 'body',
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: [
        {
          invocationKey: bodyKey,
          nodeId: 'body',
          sideEffectClass: 'safe',
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
      ],
      attempts: [
        {
          invocationKey: bodyKey,
          nodeId: 'body',
          attemptNumber: 1,
          sideEffectClass: 'safe',
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
      ],
    } as const;
    const delivery = await testDelivery(workspaceA, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'already_committed', revision: 1 });

    const scanner = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    await expect(scanner.claimDueWakeups(100)).resolves.toBe(0);
    await scanner.close();

    const freshStore = createCoordinatorRunStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    await expect(
      freshStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'ready',
      state: { checkpoint: { revision: 1, loops: [{ nextOrdinal: 1 }] } },
    });
    await freshStore.close();

    const persisted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        branch_context: unknown;
        control_kind: string | null;
        invocation_key: string;
        status: string;
      }>(
        `select invocation_key,branch_context,status,control_kind
           from app.node_runs where workflow_run_id=$1 order by invocation_key`,
        [runId],
      ),
    );
    expect(persisted.rows).toEqual([
      {
        invocation_key: bodyKey,
        branch_context: {
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
        status: 'ready',
        control_kind: null,
      },
      {
        invocation_key: controlKey,
        branch_context: { branchPath: [], iterationPath: [] },
        status: 'waiting',
        control_kind: 'for_each_barrier',
      },
    ]);
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.node_runs set branch_context='{}'::jsonb
           where workflow_run_id=$1 and invocation_key=$2`,
        [runId, bodyKey],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('loads only exact ordinal-scoped body inputs and fails closed on loop proof drift', async () => {
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
      schemaVersion: 1,
      kind: 'inline',
      value: { items, iterationCount: 2 },
    };
    const inline = (value: unknown) => ({
      schemaVersion: 1,
      kind: 'inline',
      value,
    });
    const schedulerState = {
      schemaVersion: 2,
      engineVersion: 'engine-v1',
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
      structuredCollection: {
        loopNodeId: 'loop',
        ordinal: 1,
        collection: items,
        collectionSize: 2,
        declaredCollectionChecksum: collectionChecksum,
      },
    });
    await expect(load(first0Key)).rejects.toBeInstanceOf(
      NodeAttemptStateCorruptError,
    );

    const replaceCheckpoint = async (next: unknown): Promise<void> => {
      const updated = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ scheduler_state: unknown }>(
          `update app.run_checkpoints set scheduler_state=$2::jsonb
             where workflow_run_id=$1 returning scheduler_state`,
          [runId, JSON.stringify(next)],
        ),
      );
      expect(updated.rowCount).toBe(1);
      expect(updated.rows[0]?.scheduler_state).toEqual(next);
    };
    await replaceCheckpoint({
      ...schedulerState,
      loops: [
        { ...schedulerState.loops[0], collectionChecksum: 'f'.repeat(64) },
      ],
    });
    await expect(load()).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    await replaceCheckpoint({
      ...schedulerState,
      loops: [
        {
          ...schedulerState.loops[0],
          activeOrdinals: [0],
          terminalOrdinals: [1],
        },
      ],
    });
    await expect(load()).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    const wrongAttemptId = randomUUID();
    await replaceCheckpoint({
      ...schedulerState,
      invocations: schedulerState.invocations.map((invocation) =>
        invocation.invocationKey === controlKey
          ? {
              ...invocation,
              output: { kind: 'inline', attemptId: wrongAttemptId },
            }
          : invocation,
      ),
      loops: [
        {
          ...schedulerState.loops[0],
          collection: { kind: 'inline', attemptId: wrongAttemptId },
        },
      ],
    });
    await expect(load()).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
  });
});
