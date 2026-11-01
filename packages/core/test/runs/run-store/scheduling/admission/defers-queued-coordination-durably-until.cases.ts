import { it, expect } from 'vitest';

import {
  asOwner,
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  rawStore,
  testDelivery,
  versionA,
  versionB,
  workerBaseUrl,
  workflowB,
  workspaceA,
  workspaceB,
} from '../../fixtures.js';

export function registerDefersQueuedCoordinationDurablyUntil(): void {
  it('defers queued coordination durably until an active entitlement slot is free', async () => {
    await asOwner(workspaceB, async (client) => {
      await client.query(
        `insert into app.workspace_execution_entitlement_versions (
             workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
           ) values ($1,3,'active',5,100,'-infinity'::timestamptz)`,
        [workspaceB],
      );
      await client.query(
        `update app.workspace_execution_entitlements set current_version=3
            where workspace_id=$1`,
        [workspaceB],
      );
    });
    const runScope = {
      workspaceId: workspaceB,
      workflowId: workflowB,
      workflowVersionId: versionB,
    } as const;
    const activeRunIds = await Promise.all(
      Array.from({ length: 5 }, () =>
        insertRun({ ...runScope, status: 'running' }),
      ),
    );
    const runId = await insertRun(runScope);
    await asOwner(workspaceB, (client) =>
      client.query(
        `update app.workspace_execution_entitlements set current_version=2
            where workspace_id=$1`,
        [workspaceB],
      ),
    );
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        workflowVersionId: versionB,
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: '2026-08-25T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const delivery = await testDelivery(workspaceB, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceB,
        runId,
        workflowVersionId: versionB,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'deferred', revision: 0 });

    const deferred = await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
            where workspace_id=$1 and aggregate_id=$2 and job_name='advance-workflow-run'
              and id<>$3
            order by created_at desc limit 1`,
        [workspaceB, runId, delivery.outboxEventId],
      ),
    );
    expect(deferred.rows).toHaveLength(1);
    const retry = deferred.rows[0];
    if (retry === undefined)
      throw new Error('Deferred coordinator row missing');
    await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query(
        `update app.workflow_runs set status='succeeded',completed_at=clock_timestamp()
            where workspace_id=$1 and id=$2`,
        [workspaceB, activeRunIds[0]],
      ),
    );
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceB,
        runId,
        workflowVersionId: versionB,
        delivery: {
          outboxEventId: retry.id,
          payloadChecksum: retry.payload_checksum,
        },
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query<{
        active_runs: number;
        actual_queued: number;
        queued_runs: number;
        run_status: string;
      }>(
        `select counter.active_runs,counter.queued_runs,run.status run_status,
                  (select count(*)::integer from app.workflow_runs queued
                    where queued.workspace_id=counter.workspace_id
                      and queued.status='queued') actual_queued
             from app.workspace_execution_admission_counters counter
             join app.workflow_runs run on run.workspace_id=counter.workspace_id
            where counter.workspace_id=$1 and run.id=$2`,
        [workspaceB, runId],
      ),
    );
    expect(proof.rows).toEqual([
      {
        active_runs: 5,
        actual_queued: 0,
        queued_runs: 0,
        run_status: 'running',
      },
    ]);
  });

  it('reports database-observed schedule-to-start only for the CAS winner', async () => {
    const due = await asOwner(workspaceA, (client) =>
      client.query<{ scheduled_at: Date }>(
        "select clock_timestamp()-interval '4.25 seconds' scheduled_at",
      ),
    );
    const scheduledAt = due.rows[0]?.scheduled_at.toISOString();
    if (scheduledAt === undefined)
      throw new Error('Database schedule timestamp missing');
    const startedAt = new Date(Date.parse(scheduledAt) + 4_250).toISOString();
    const runId = await insertRun({
      triggerType: 'schedule',
      inputRef: {
        kind: 'inline',
        value: {
          triggerId: randomUUID(),
          nodeId: 'schedule-start-proof',
          scheduledAt,
        },
      },
    });
    const plan = {
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
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: startedAt,
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const delivery = await testDelivery(workspaceA, runId, 0);
    const before = await asOwner(workspaceA, (client) =>
      client.query<{ observed_at: Date }>(
        'select clock_timestamp() observed_at',
      ),
    );
    const committed = await rawStore.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      delivery,
      plan,
      signal: new AbortController().signal,
    });
    const after = await asOwner(workspaceA, (client) =>
      client.query<{ observed_at: Date }>(
        'select clock_timestamp() observed_at',
      ),
    );
    expect(committed).toMatchObject({ kind: 'committed', revision: 1 });
    if (committed.kind !== 'committed')
      throw new Error('Schedule start was not committed');
    const beforeSeconds =
      ((before.rows[0]?.observed_at.getTime() ?? Number.NaN) -
        Date.parse(scheduledAt)) /
      1_000;
    const afterSeconds =
      ((after.rows[0]?.observed_at.getTime() ?? Number.NaN) -
        Date.parse(scheduledAt)) /
      1_000;
    expect(committed.scheduleToStartSeconds).toBeGreaterThanOrEqual(
      beforeSeconds,
    );
    expect(committed.scheduleToStartSeconds).toBeLessThanOrEqual(afterSeconds);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'already_committed', revision: 1 });
  });
}
