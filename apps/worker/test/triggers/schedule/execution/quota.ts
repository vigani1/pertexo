import { createHash, randomUUID } from 'node:crypto';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';

import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import { expect, vi } from 'vitest';
import { WorkerDrainState } from '../../../../src/runtime/shutdown/drain-state.js';

import { createTriggerRuntime } from '../../../../src/triggers/runtime.js';
import { OutboxDispatcher } from '../../../../src/transport/outbox/dispatch/runtime.js';

import {
  actorId,
  apiQuery,
  dispatcherConfig,
  ownerQuery,
  ownerQueryIn,
  redisUrl,
  workerConfig,
  workspaceId,
  resources,
  registerResource,
  transferResource,
} from '../fixture.js';
import type { seedScheduleQualification } from './seed.js';

export async function assertScheduleQuotaRecovery(
  context: Pick<
    Awaited<ReturnType<typeof seedScheduleQualification>>,
    'identity' | 'authoring' | 'graph' | 'catalog'
  > &
    Readonly<{
      runtime: Awaited<ReturnType<typeof createTriggerRuntime>>;
      triggerId: string;
      firstOccurrence: Readonly<{
        scheduled_at: Date;
        workflow_run_id: string;
      }>;
    }>,
) {
  const { identity, authoring, graph, catalog, firstOccurrence, triggerId } =
    context;
  let { runtime } = context;
  const otherActorId = randomUUID();
  const otherWorkspaceId = randomUUID();
  await identity.createUser({
    id: otherActorId,
    email: `worker-schedule-${otherActorId}@example.test`,
    displayName: 'Other Schedule Owner',
  });
  await identity.createWorkspaceWithOwner({
    id: otherWorkspaceId,
    name: 'Other Schedule Workspace',
    slug: `worker-schedule-${otherActorId}`,
    ownerUserId: otherActorId,
    idempotencyKey: `worker-schedule-${otherActorId}`,
  });
  const publishAdditionalSchedule = async (
    scopedWorkspaceId: string,
    scopedActorId: string,
    suffix: string,
  ) => {
    const createdSchedule = await authoring.createWorkflow({
      actorId: scopedActorId,
      workspaceId: scopedWorkspaceId,
      name: `Schedule ${suffix}`,
      emptyGraph: { settings: {}, nodes: [], edges: [] },
      idempotencyKey: `create-${suffix}`,
    });
    const saved = await authoring.saveDraft({
      actorId: scopedActorId,
      workspaceId: scopedWorkspaceId,
      workflowId: createdSchedule.workflowId,
      representationTag: workflowDraftRepresentationTag({
        workflowId: createdSchedule.workflowId,
        revision: createdSchedule.draft.revision,
        graph: createdSchedule.draft.graphJson,
        compatibilityFingerprint:
          createdSchedule.draft.compatibility.fingerprint,
      }),
      expectedRevision: 1,
      graphJson: graph,
    });
    const published = await authoring.publishWorkflow({
      actorId: scopedActorId,
      workspaceId: scopedWorkspaceId,
      workflowId: createdSchedule.workflowId,
      representationTag: workflowDraftRepresentationTag({
        workflowId: createdSchedule.workflowId,
        revision: saved.revision,
        graph: saved.graphJson,
        compatibilityFingerprint: workflowCompatibilityReport(
          saved.graphJson,
          catalog,
        ).fingerprint,
      }),
      idempotencyKey: `publish-${suffix}`,
      requestHash: createHash('sha256').update(suffix).digest('hex'),
    });
    return { workflowId: createdSchedule.workflowId, published };
  };
  const saturated = await publishAdditionalSchedule(
    workspaceId,
    actorId,
    'saturated',
  );
  const fair = await publishAdditionalSchedule(
    otherWorkspaceId,
    otherActorId,
    'fair',
  );

  runtime = registerResource(
    await createTriggerRuntime({
      batchSize: 10,
      database: workerConfig,
      leaseDurationSeconds: 5,
      leaseOwner: 'schedule-runtime-reconstructed',
      onTimeWindowSeconds: 300,
      pollIntervalMillis: 25,
      redisUrl,
    }),
  );
  await runtime.consumer.waitUntilReady(5_000);
  const recoveryDatabase = registerResource(
    createOutboxDispatcherDatabase(dispatcherConfig),
  );
  const recoveryProducer = registerResource(createQueueProducer({ redisUrl }));
  const recoveryDispatcher = registerResource(
    new OutboxDispatcher(recoveryDatabase, recoveryProducer, {
      drainState: new WorkerDrainState(),
      options: {
        batchSize: 10,
        jobNames: [JOB_NAME.reconcileWorkflowTriggers],
        leaseDurationMillis: 1_000,
        leaseOwner: 'schedule-recovery-dispatcher',
        operationTimeoutMillis: 5_000,
        retryDelayMillis: 10,
      },
    }),
  );
  transferResource(recoveryDatabase);
  transferResource(recoveryProducer);
  await expect(recoveryDispatcher.dispatchOnce()).resolves.toMatchObject({
    published: 2,
  });
  const scheduleTriggerId = async (
    scopedWorkspaceId: string,
    workflowId: string,
  ) => {
    let id: string | undefined;
    await vi.waitFor(
      async () => {
        const result = await ownerQueryIn<{ trigger_id: string }>(
          scopedWorkspaceId,
          `select schedule.trigger_id from app.trigger_schedules schedule
              join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
             where trigger.workflow_id=$1 and trigger.status='active'`,
          [workflowId],
        );
        id = result.rows[0]?.trigger_id;
        expect(id).toBeDefined();
      },
      { timeout: 5_000, interval: 25 },
    );
    if (id === undefined) throw new Error('Additional schedule is missing');
    return id;
  };
  const saturatedTriggerId = await scheduleTriggerId(
    workspaceId,
    saturated.workflowId,
  );
  const fairTriggerId = await scheduleTriggerId(
    otherWorkspaceId,
    fair.workflowId,
  );
  const seedDue = (
    scopedWorkspaceId: string,
    seededTriggerId: string,
    ageMinutes: number,
  ) =>
    ownerQueryIn(
      scopedWorkspaceId,
      `with materialized as (
           delete from app.trigger_schedules where trigger_id=$1 returning *
         ) insert into app.trigger_schedules
           (trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
            interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,
            last_fire_at,status,health_status,last_error_code,created_at,updated_at,
            admission_deferred_until)
         select trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
            interval_minutes,misfire_policy,config_fingerprint,
            clock_timestamp()-make_interval(mins=>$2),
            clock_timestamp()-make_interval(mins=>$2-1),null,status,health_status,null,
            created_at,clock_timestamp(),null from materialized`,
      [seededTriggerId, ageMinutes],
    );
  await runtime.close();
  transferResource(runtime);
  await seedDue(workspaceId, saturatedTriggerId, 4);
  await seedDue(otherWorkspaceId, fairTriggerId, 3);

  await ownerQuery(
    `insert into app.workspace_execution_entitlement_versions
        (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values($1,2,'active',5,1,'-infinity')`,
    [workspaceId],
  );
  await ownerQuery(
    `update app.workspace_execution_entitlements set current_version=2
        where workspace_id=$1`,
    [workspaceId],
  );
  const quotaOccupantRunId = randomUUID();
  const occupiedRun = await apiQuery<{ workflow_id: string }>(
    'select workflow_id from app.workflow_runs where id=$1',
    [firstOccurrence.workflow_run_id],
  );
  const occupiedWorkflowId = occupiedRun.rows[0]?.workflow_id;
  if (occupiedWorkflowId === undefined)
    throw new Error('Quota fixture workflow missing');
  await apiQuery(
    `insert into app.workflow_runs
         (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
       select $2,workspace_id,workflow_id,workflow_version_id,'manual','queued'
         from app.workflow_runs where id=$1`,
    [firstOccurrence.workflow_run_id, quotaOccupantRunId],
    {
      workflowId: occupiedWorkflowId,
      keyHash: createHash('sha256').update(quotaOccupantRunId).digest('hex'),
    },
  );
  const crashedClaim = await ownerQuery(
    'select * from app.claim_due_trigger_schedules($1,1,30)',
    ['expired-runtime'],
  );
  expect(crashedClaim.rows[0]).toMatchObject({
    trigger_id: saturatedTriggerId,
  });
  await ownerQuery(
    `update app.trigger_schedules
          set lease_acquired_at=clock_timestamp()-interval '2 seconds',
              lease_expires_at=clock_timestamp()-interval '1 second'
        where trigger_id=$1`,
    [saturatedTriggerId],
  );

  runtime = await createTriggerRuntime({
    batchSize: 10,
    database: workerConfig,
    leaseDurationSeconds: 5,
    leaseOwner: 'schedule-runtime-reconstructed',
    onTimeWindowSeconds: 300,
    pollIntervalMillis: 25,
    redisUrl,
  });
  resources.push(runtime);
  await runtime.consumer.waitUntilReady(5_000);
  await vi.waitFor(
    async () => {
      const backlog = await ownerQuery<{
        due: boolean;
        lease_owner: string | null;
        last_error_code: string | null;
      }>(
        `select next_fire_at<=clock_timestamp() due,lease_owner,last_error_code
             from app.trigger_schedules where trigger_id=$1`,
        [saturatedTriggerId],
      );
      expect(backlog.rows[0]).toEqual({
        due: true,
        lease_owner: null,
        last_error_code: 'schedule.admission_throttled',
      });
      const fairOccurrence = await ownerQueryIn<{ count: string }>(
        otherWorkspaceId,
        `select count(*) count from app.trigger_schedule_occurrences
            where trigger_id=$1`,
        [fairTriggerId],
      );
      expect(fairOccurrence.rows[0]?.count).toBe('1');
    },
    { timeout: 5_000, interval: 25 },
  );
  await ownerQuery(
    "update app.workflow_runs set status='succeeded' where id=$1",
    [quotaOccupantRunId],
  );
  await ownerQuery(
    `update app.trigger_schedules set admission_deferred_until=null
        where trigger_id=$1`,
    [saturatedTriggerId],
  );
  await vi.waitFor(
    async () => {
      const recovered = await ownerQuery<{ count: string }>(
        'select count(*) count from app.trigger_schedule_occurrences where trigger_id=$1',
        [saturatedTriggerId],
      );
      expect(recovered.rows[0]?.count).toBe('1');
    },
    { timeout: 5_000, interval: 25 },
  );

  await runtime.close();
  resources.splice(resources.indexOf(runtime), 1);
  const beforeDrain = await ownerQuery<{ count: string }>(
    'select count(*) count from app.trigger_schedule_occurrences where trigger_id=$1',
    [triggerId],
  );
  await ownerQuery(
    `update app.trigger_schedules
          set next_fire_at=clock_timestamp()-interval '4 minutes',last_fire_at=null
       where trigger_id=$1`,
    [triggerId],
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterDrain = await ownerQuery<{
    count: string;
    due: boolean;
    lease_owner: string | null;
  }>(
    `select (select count(*) from app.trigger_schedule_occurrences where trigger_id=$1) count,
              next_fire_at<=clock_timestamp() due,lease_owner
         from app.trigger_schedules where trigger_id=$1`,
    [triggerId],
  );
  expect(afterDrain.rows[0]).toEqual({
    count: beforeDrain.rows[0]?.count,
    due: true,
    lease_owner: null,
  });
}
