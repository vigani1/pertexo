import { it, expect } from 'vitest';
import {
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

export function registerCommitsPersistedRetryFactsAdmits(): void {
  it('commits persisted retry facts and admits a due retry', async () => {
    const invocationKey = 'retry/past';
    const dueAt = '2020-01-01T00:00:00.000Z';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'past',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const firstAttemptInput = {
      kind: 'inline',
      value: { attempt: 1 },
    };
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,retry_due_at,wait_kind,
             input_ref
           ) values ($1,$2,$3,$4,$5,'{}','waiting','safe',$6,1,$7,'retry_backoff',$8::jsonb)`,
        [
          nodeRunId,
          workspaceA,
          runId,
          'past',
          invocationKey,
          attemptId,
          dueAt,
          JSON.stringify(firstAttemptInput),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'failed','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.retry_scheduled',$3::jsonb)`,
        [
          workspaceA,
          runId,
          JSON.stringify({
            nodeRunId,
            attemptId,
            dueAt,
          }),
        ],
      );
    });
    const fresh = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(fresh).toMatchObject({ kind: 'ready' });
    if (fresh.kind !== 'ready') throw new Error('expected ready state');
    expect(fresh.state.observations).toEqual([
      expect.objectContaining({
        kind: 'wait',
        eventName: 'node.retry_scheduled',
        sequence: 2,
        invocationKey,
        attemptNumber: 1,
        resumeAt: dueAt,
      }),
    ]);
    const waitingCheckpoint = checkpoint({
      revision: 1,
      runStatus: 'waiting',
      nextEventSequence: 4,
      invocations: [
        {
          invocationKey,
          nodeId: 'past',
          status: 'waiting',
          attemptNumber: 1,
          resumeAt: dueAt,
          waitKind: 'retry_backoff',
        },
      ],
    });
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: waitingCheckpoint,
          events: [
            {
              sequence: 3,
              name: 'run.waiting',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });

    const afterWaiting = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(afterWaiting).toMatchObject({ kind: 'ready' });
    if (afterWaiting.kind !== 'ready') throw new Error('expected ready state');
    expect(afterWaiting.state.observations).toEqual([
      { kind: 'due_at', invocationKey, occurredAt: dueAt },
    ]);

    const retryPlan = {
      expectedRevision: 1,
      expectedNextEventSequence: 4,
      consumedThroughEventSequence: 3,
      checkpoint: checkpoint({
        revision: 2,
        runStatus: 'running',
        nextEventSequence: 5,
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId: 'past',
            status: 'running',
            attemptNumber: 2,
          },
        ],
      }),
      events: [
        {
          sequence: 4,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey,
          nodeId: 'past',
          attemptNumber: 1,
        },
      ],
      nodeRunAdmissions: [],
      attempts: [
        {
          admissionKind: 'retry',
          invocationKey,
          nodeId: 'past',
          attemptNumber: 2,
          sideEffectClass: 'safe',
        },
      ],
    } as const;
    const retry = ownedDeliveryStore.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: retryPlan,
    });
    await expect(retry).resolves.toMatchObject({
      kind: 'committed',
      revision: 2,
    });
    // An admitted retry starts without its predecessor's recorded input.
    const recorded = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ input_ref: unknown }>(
        `select input_ref from app.node_runs where workspace_id=$1 and id=$2`,
        [workspaceA, nodeRunId],
      ),
    );
    expect(recorded.rows[0]?.input_ref).toBeNull();
  });
}
