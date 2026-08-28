import { describe, it, expect } from 'vitest';

import {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  apiBaseUrl,
  asOwner,
  asRuntime,
  checkpoint,
  insertRun,
  nodeAttemptStore,
  store,
  versionA,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';

describe('Coordinator CAS and transition invariants', () => {
  it('has one concurrent CAS winner and classifies the exact replay', async () => {
    const runId = await insertRun({});
    const next = checkpoint({
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 3,
    });
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: next,
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
        ],
        nodeRunAdmissions: [],
        attempts: [],
      },
    } as const;
    const raced = await Promise.all([
      store.commitAdvancePlan(input),
      store.commitAdvancePlan(input),
    ]);
    expect(raced.map(({ kind }) => kind).sort()).toEqual([
      'already_committed',
      'committed',
    ]);
    await expect(store.commitAdvancePlan(input)).resolves.toEqual({
      kind: 'already_committed',
      revision: 1,
    });
    const receipts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ completed: number }>(
        `select count(*)::int completed
           from app.inbox_receipts receipt
           join app.outbox_events event on event.id=receipt.message_id
           where event.aggregate_id=$1 and receipt.completed_at is not null`,
        [runId],
      ),
    );
    expect(receipts.rows[0]?.completed).toBe(1);
  });

  it('uses the exact transition fingerprint for event and admission replays', async () => {
    const firstRun = await insertRun({});
    const basePlan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          schemaVersion: 1,
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    } as const;
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: firstRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: basePlan,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: firstRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          ...basePlan,
          events: [
            { ...basePlan.events[0], occurredAt: '2026-08-21T00:00:01.000Z' },
          ],
        },
      }),
    ).resolves.toEqual({ kind: 'stale', revision: 1 });

    const secondRun = await insertRun({});
    const invocationA = 'fingerprint/a';
    const invocationB = 'fingerprint/b';
    const admissions = [
      { invocationKey: invocationA, nodeId: 'a', sideEffectClass: 'safe' },
      { invocationKey: invocationB, nodeId: 'b', sideEffectClass: 'safe' },
    ] as const;
    const admissionPlan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 5,
        readySet: [invocationA, invocationB],
        invocations: [
          {
            invocationKey: invocationA,
            nodeId: 'a',
            status: 'ready',
            attemptNumber: 0,
          },
          {
            invocationKey: invocationB,
            nodeId: 'b',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
      }),
      events: [
        {
          schemaVersion: 1,
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
        {
          schemaVersion: 1,
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey: invocationA,
          nodeId: 'a',
          attemptNumber: 0,
        },
        {
          schemaVersion: 1,
          sequence: 4,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey: invocationB,
          nodeId: 'b',
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: admissions,
      attempts: [],
    } as const;
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: secondRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: admissionPlan,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: secondRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          ...admissionPlan,
          nodeRunAdmissions: [admissions[1], admissions[0]],
        },
      }),
    ).resolves.toEqual({ kind: 'stale', revision: 1 });
  });

  it('rejects forged sticky facts, source-owned cancel events, and attempts after either sticky fact', async () => {
    const runId = await insertRun({});
    for (const sticky of ['cancelRequested', 'deadlineExpired'] as const) {
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: checkpoint({
              revision: 1,
              nextEventSequence: 2,
              [sticky]: true,
            }),
            events: [],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    }
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({ revision: 1, nextEventSequence: 3 }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.cancel_requested',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    for (const sticky of ['cancelRequested', 'deadlineExpired'] as const) {
      const invocationKey = `sticky/${sticky}`;
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: checkpoint({
              revision: 1,
              runStatus: 'running',
              nextEventSequence: 4,
              [sticky]: true,
              admittedInvocationKeys: [invocationKey],
              invocations: [
                {
                  invocationKey,
                  nodeId: sticky,
                  status: 'running',
                  attemptNumber: 1,
                },
              ],
            }),
            events: [
              {
                schemaVersion: 1,
                sequence: 2,
                name: 'run.started',
                occurredAt: '2026-08-21T00:00:00.000Z',
              },
              {
                schemaVersion: 1,
                sequence: 3,
                name: 'node.ready',
                occurredAt: '2026-08-21T00:00:00.000Z',
                invocationKey,
                nodeId: sticky,
                attemptNumber: 0,
              },
            ],
            nodeRunAdmissions: [
              { invocationKey, nodeId: sticky, sideEffectClass: 'safe' },
            ],
            attempts: [
              {
                invocationKey,
                nodeId: sticky,
                attemptNumber: 1,
                sideEffectClass: 'safe',
              },
            ],
          },
        }),
      ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    }
    const physical = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ attempts: number; nodes: number }>(
        `select
             (select count(*)::int from app.node_runs where workflow_run_id=$1) nodes,
             (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempts`,
        [runId],
      ),
    );
    expect(physical.rows[0]).toEqual({ nodes: 0, attempts: 0 });
  });

  it('requires exact old-to-new node-run and attempt admission deltas', async () => {
    const newInvocation = 'delta/new';
    const missingNodeRun = await insertRun({});
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: missingNodeRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 4,
            readySet: [newInvocation],
            invocations: [
              {
                invocationKey: newInvocation,
                nodeId: 'new',
                status: 'ready',
                attemptNumber: 0,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: newInvocation,
              nodeId: 'new',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);

    const existingInvocation = 'delta/existing';
    const missingAttempt = await insertRun({
      schedulerState: checkpoint({
        readySet: [existingInvocation],
        invocations: [
          {
            invocationKey: existingInvocation,
            nodeId: 'existing',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
      }),
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: missingAttempt,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 3,
            admittedInvocationKeys: [existingInvocation],
            invocations: [
              {
                invocationKey: existingInvocation,
                nodeId: 'existing',
                status: 'running',
                attemptNumber: 1,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: missingAttempt,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 3,
            readySet: [existingInvocation],
            admittedInvocationKeys: [existingInvocation],
            invocations: [
              {
                invocationKey: existingInvocation,
                nodeId: 'existing',
                status: 'ready',
                attemptNumber: 0,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ nodes: number; revisions: number[] }>(
        `select
             (select count(*)::int from app.node_runs where workflow_run_id=any($1::uuid[])) nodes,
             (select array_agg(revision order by workflow_run_id) from app.run_checkpoints where workflow_run_id=any($1::uuid[])) revisions`,
        [[missingNodeRun, missingAttempt]],
      ),
    );
    expect(proof.rows[0]).toEqual({ nodes: 0, revisions: [0, 0] });
  });

  it('returns stale when cancellation or deadline changes after load even without attempts', async () => {
    for (const kind of ['cancel', 'deadline'] as const) {
      const runId = await insertRun({
        ...(kind === 'deadline'
          ? { deadlineAt: new Date(Date.now() + 100).toISOString() }
          : {}),
      });
      const next = checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      });
      await expect(
        store.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: 'ready' });
      if (kind === 'cancel') {
        await asRuntime(apiBaseUrl, workspaceA, async (client) => {
          await client.query(
            `update app.workflow_runs set cancel_requested_at=now(), cancel_requested_by='test' where id=$1`,
            [runId],
          );
          await client.query(
            `insert into app.run_events (workspace_id,workflow_run_id,sequence,type,payload)
               values ($1,$2,2,'run.cancel_requested','{"schemaVersion":1}')`,
            [workspaceA, runId],
          );
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: next,
            events: [
              {
                schemaVersion: 1,
                sequence: 2,
                name: 'run.started',
                occurredAt: '2026-08-21T00:00:00.000Z',
              },
            ],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).resolves.toEqual({ kind: 'stale', revision: 0 });
    }
  });

  it('rolls back all writes when a late physical event membership check fails', async () => {
    const admitted = 'version-a/admitted';
    const ghost = 'version-a/ghost';
    const runId = await insertRun({
      schedulerState: checkpoint({
        readySet: [ghost],
        invocations: [
          {
            invocationKey: ghost,
            nodeId: 'ghost',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
      }),
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 5,
            readySet: [],
            admittedInvocationKeys: [admitted],
            invocations: [
              {
                invocationKey: admitted,
                nodeId: 'admitted',
                status: 'running',
                attemptNumber: 1,
              },
              {
                invocationKey: ghost,
                nodeId: 'ghost',
                status: 'failed',
                attemptNumber: 0,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: admitted,
              nodeId: 'admitted',
              attemptNumber: 0,
            },
            {
              schemaVersion: 1,
              sequence: 4,
              name: 'node.failed',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: ghost,
              nodeId: 'ghost',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [
            {
              invocationKey: admitted,
              nodeId: 'admitted',
              sideEffectClass: 'safe',
            },
          ],
          attempts: [
            {
              invocationKey: admitted,
              nodeId: 'admitted',
              attemptNumber: 1,
              sideEffectClass: 'safe',
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    const counts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        nodes: number;
        attempts: number;
        events: number;
        inbox: number;
        revision: number;
      }>(
        `select
             (select count(*)::int from app.node_runs where workflow_run_id=$1) nodes,
             (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempts,
             (select count(*)::int from app.run_events where workflow_run_id=$1) events,
             (select count(*)::int from app.inbox_receipts receipt
               join app.outbox_events event on event.id=receipt.message_id
               where event.aggregate_id=$1) inbox,
             (select revision from app.run_checkpoints where workflow_run_id=$1) revision`,
        [runId],
      ),
    );
    expect(counts.rows[0]).toEqual({
      nodes: 0,
      attempts: 0,
      events: 1,
      inbox: 0,
      revision: 0,
    });
  });

  it('atomically persists branch-scoped ready and skipped node runs', async () => {
    const selectedKey = `${versionA}|selected|b:condition%3Atrue|i:`;
    const skippedKey = `${versionA}|skipped|b:condition%3Afalse|i:`;
    const initial = {
      ...checkpoint({}),
      schemaVersion: 2,
      branchSelections: [],
    } as const;
    const runId = await insertRun({ schedulerState: initial });

    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: {
            ...initial,
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 5,
            admittedInvocationKeys: [selectedKey],
            invocations: [
              {
                invocationKey: selectedKey,
                nodeId: 'selected',
                status: 'running',
                attemptNumber: 1,
                branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
              },
              {
                invocationKey: skippedKey,
                nodeId: 'skipped',
                status: 'skipped',
                attemptNumber: 0,
                branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
              },
            ],
          },
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-24T00:00:00.000Z',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-24T00:00:00.000Z',
              invocationKey: selectedKey,
              nodeId: 'selected',
              attemptNumber: 0,
            },
            {
              schemaVersion: 1,
              sequence: 4,
              name: 'node.skipped',
              occurredAt: '2026-08-24T00:00:00.000Z',
              invocationKey: skippedKey,
              nodeId: 'skipped',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [
            {
              invocationKey: selectedKey,
              nodeId: 'selected',
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
            },
            {
              invocationKey: skippedKey,
              nodeId: 'skipped',
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
            },
          ],
          attempts: [
            {
              invocationKey: selectedKey,
              nodeId: 'selected',
              attemptNumber: 1,
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });

    const persisted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        invocation_key: string;
        branch_context: unknown;
        status: string;
        attempts: number;
        deliveries: number;
      }>(
        `select node.invocation_key,node.branch_context,node.status,
                    count(distinct attempt.id)::int attempts,
                    count(distinct event.id)::int deliveries
               from app.node_runs node
               left join app.node_attempts attempt on attempt.node_run_id=node.id
               left join app.outbox_events event
                 on event.aggregate_id=attempt.id
                and event.job_name='execute-node-attempt'
              where node.workspace_id=$1 and node.workflow_run_id=$2
              group by node.id
              order by node.invocation_key`,
        [workspaceA, runId],
      ),
    );
    expect(persisted.rows).toEqual([
      {
        invocation_key: selectedKey,
        branch_context: {
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
        status: 'ready',
        attempts: 1,
        deliveries: 1,
      },
      {
        invocation_key: skippedKey,
        branch_context: {
          branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
        },
        status: 'skipped',
        attempts: 0,
        deliveries: 0,
      },
    ]);
    const selectedAttempt = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{
          attempt_id: string;
          node_run_id: string;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select attempt.id attempt_id,node.id node_run_id,
                    event.id outbox_id,event.payload_checksum
               from app.node_runs node
               join app.node_attempts attempt on attempt.node_run_id=node.id
               join app.outbox_events event on event.aggregate_id=attempt.id
              where node.workspace_id=$1 and node.workflow_run_id=$2
                and node.invocation_key=$3
                and event.job_name='execute-node-attempt'`,
          [workspaceA, runId, selectedKey],
        ),
    );
    const selectedDelivery = selectedAttempt.rows[0];
    if (selectedDelivery === undefined)
      throw new Error('branch-scoped fixture attempt missing');
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: selectedDelivery.node_run_id,
        attemptId: selectedDelivery.attempt_id,
        delivery: {
          outboxEventId: selectedDelivery.outbox_id,
          payloadChecksum: selectedDelivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-branch',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'claimed',
      lease: {
        invocationKey: selectedKey,
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
      },
    });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'ready' });
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.node_runs set branch_context='{}'::jsonb
           where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3`,
        [workspaceA, runId, skippedKey],
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
});
