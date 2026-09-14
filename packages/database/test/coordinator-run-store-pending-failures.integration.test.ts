import { describe, it, expect } from 'vitest';

import {
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  rawStore,
  ownedDeliveryStore,
  testDelivery,
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

    const loaded = await ownedDeliveryStore.loadAdvanceState({
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
      ownedDeliveryStore.commitAdvancePlan({
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

  it('commits a terminal pending-failure decision through the store', async () => {
    const invocationKey = 'coordinator/retry/terminal';
    const attemptId = randomUUID();
    const nodeRunId = randomUUID();
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'terminal-node',
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
         ) values ($1,$2,$3,'terminal-node',$4,'{}','running','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
           safe_error_code,executor_failure_kind,executor_error_kind,
           executor_possibly_dispatched,retry_decision,completed_at
         ) values ($1,$2,$3,1,'failed','safe','provider.unavailable','failed',
           'provider',false,'pending',clock_timestamp())`,
        [attemptId, workspaceA, nodeRunId],
      );
    });
    const delivery = await testDelivery(workspaceA, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'failed',
            nextEventSequence: 4,
            invocations: [
              {
                invocationKey,
                nodeId: 'terminal-node',
                status: 'failed',
                attemptNumber: 1,
              },
            ],
            admittedInvocationKeys: [invocationKey],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'node.failed',
              occurredAt: '2026-09-13T00:00:00.000Z',
              invocationKey,
              nodeId: 'terminal-node',
              attemptNumber: 1,
              reasonCode: 'provider.unavailable',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.failed',
              occurredAt: '2026-09-13T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `select node.status,attempt.retry_decision
           from app.node_runs node
           join app.node_attempts attempt on attempt.id=node.current_attempt_id
           where node.workspace_id=$1 and node.id=$2`,
          [workspaceA, nodeRunId],
        ),
      ),
    ).resolves.toMatchObject({
      rows: [{ status: 'failed', retry_decision: 'failed' }],
    });
  });

  it('rolls back a pending-failure plan without its required node decision', async () => {
    const invocationKey = 'coordinator/retry/rejected';
    const attemptId = randomUUID();
    const nodeRunId = randomUUID();
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'rejected-node',
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
         ) values ($1,$2,$3,'rejected-node',$4,'{}','running','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
           safe_error_code,executor_failure_kind,executor_error_kind,
           executor_possibly_dispatched,retry_decision,completed_at
         ) values ($1,$2,$3,1,'failed','safe','provider.unavailable','failed',
           'provider',false,'pending',clock_timestamp())`,
        [attemptId, workspaceA, nodeRunId],
      );
    });
    const delivery = await testDelivery(workspaceA, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'failed',
            nextEventSequence: 3,
            invocations: [
              {
                invocationKey,
                nodeId: 'rejected-node',
                status: 'failed',
                attemptNumber: 1,
              },
            ],
            admittedInvocationKeys: [invocationKey],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.failed',
              occurredAt: '2026-09-13T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toThrow('Coordinator advance plan is invalid');
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `select checkpoint.revision,node.status,attempt.retry_decision,
                  count(receipt.message_id)::int receipt_count
           from app.run_checkpoints checkpoint
           join app.node_runs node on node.workflow_run_id=checkpoint.workflow_run_id
           join app.node_attempts attempt on attempt.id=node.current_attempt_id
           left join app.inbox_receipts receipt on receipt.message_id=$3
           where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2
           group by checkpoint.revision,node.status,attempt.retry_decision`,
          [workspaceA, runId, delivery.outboxEventId],
        ),
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          revision: 0,
          status: 'running',
          retry_decision: 'pending',
          receipt_count: 0,
        },
      ],
    });
  });
});
