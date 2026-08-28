import { describe, it, expect } from 'vitest';

import {
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  store,
  versionA,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';

describe('Coordinator pending failure evidence invariants', () => {
  it('loads and atomically resolves pending executor failure evidence', async () => {
    const invocationKey = 'coordinator/retry/pending';
    const attemptId = randomUUID();
    const nodeRunId = randomUUID();
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'retry-node',
            status: 'running',
            attemptNumber: 1,
          },
        ],
        admittedInvocationKeys: [invocationKey],
      }),
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number
           ) values ($1,$2,$3,'retry-node',$4,'{}','running','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
             safe_error_code,executor_failure_kind,executor_error_kind,
             executor_possibly_dispatched,retry_decision,completed_at
           ) values ($1,$2,$3,1,'failed','safe','execution.rate_limit','retry',
                     'rate_limit',false,'pending',$4)`,
        [attemptId, workspaceA, nodeRunId, '2026-08-20T10:00:30.000Z'],
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
        observations: [
          {
            kind: 'attempt_failure',
            attemptId,
            invocationKey,
            failureKind: 'retry',
            errorKind: 'rate_limit',
            possiblyDispatched: false,
          },
        ],
      },
    });

    const dueAt = '2026-08-20T10:00:30.897Z';
    const nextCheckpoint = checkpoint({
      revision: 1,
      runStatus: 'waiting',
      nextEventSequence: 4,
      invocations: [
        {
          invocationKey,
          nodeId: 'retry-node',
          status: 'waiting',
          attemptNumber: 1,
          resumeAt: dueAt,
          waitKind: 'retry_backoff',
        },
      ],
      admittedInvocationKeys: [invocationKey],
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: nextCheckpoint,
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'node.retry_scheduled',
              occurredAt: '2026-08-20T10:01:00.000Z',
              invocationKey,
              nodeId: 'retry-node',
              attemptNumber: 1,
              dueAt,
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.waiting',
              occurredAt: '2026-08-20T10:01:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });

    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await expect(
        client.query(
          `select node.status,node.retry_due_at,attempt.retry_decision
           from app.node_runs node join app.node_attempts attempt
             on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id
           where node.id=$1`,
          [nodeRunId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            status: 'waiting',
            retry_due_at: new Date(dueAt),
            retry_decision: 'retry',
          },
        ],
      });
    });
  });
});
