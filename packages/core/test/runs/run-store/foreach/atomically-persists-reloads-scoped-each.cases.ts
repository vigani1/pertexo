import { it, expect } from 'vitest';
import {
  asRuntime,
  checkpoint,
  createTestRunStore,
  createDueNodeWakeupScanner,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  randomUUID,
  rawStore,
  ownedDeliveryStore,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

import { recordBenchmarkOperation } from './fixture.js';

export function registerAtomicallyPersistsReloadsScopedEach(): void {
  it('atomically persists and reloads a scoped For Each barrier and first body admission', async () => {
    const loopItems = Array.from(
      { length: 128 },
      (_, index) => `item-${String(index).padStart(3, '0')}`,
    );
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
      branchSelections: [],
      initialIterationBudget: 128,
      remainingIterationBudget: 128,
    } as const;
    const runId = await insertRun({
      schedulerState: current,
      status: 'running',
    });
    const storedOutput = {
      kind: 'inline',
      value: { items: loopItems, iterationCount: loopItems.length },
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
            nodeRunId: controlNodeRunId,
            attemptId: controlAttemptId,
          }),
        ],
      );
    });

    let operationStartedAt = performance.now();
    const loaded = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    recordBenchmarkOperation('loop-state-load', operationStartedAt);
    expect(loaded).toMatchObject({
      kind: 'ready',
      state: {
        completedOutputs: [
          {
            invocationKey: controlKey,
            value: { items: loopItems, iterationCount: loopItems.length },
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
          collectionSize: loopItems.length,
          maxConcurrency: 1,
          maxIterations: loopItems.length,
          nextOrdinal: 1,
          activeOrdinals: [0],
          completedPrefix: 0,
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
    operationStartedAt = performance.now();
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
    recordBenchmarkOperation('loop-plan-commit', operationStartedAt);
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
      }),
    );
    try {
      await expect(scanner.claimDueWakeups(100)).resolves.toBe(0);
    } finally {
      await scanner.close();
    }

    const freshStore = createTestRunStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
      }),
    );
    try {
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
    } finally {
      await freshStore.close();
    }

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
  });
}
