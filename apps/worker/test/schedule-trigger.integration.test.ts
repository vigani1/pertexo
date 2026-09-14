import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  createIdentityWorkspaceDatabase,
  createOutboxDispatcherDatabase,
  createScheduleTriggerScanner,
  createWorkflowAuthoringDatabase,
} from '@pertexo/database/testing';
import {
  createQueueProducer,
  JOB_NAME,
  jobIdForOutboxEvent,
} from '@pertexo/queue';
import { createCheckpoint } from '@pertexo/workflow-engine';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/graph';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createTriggerRuntime } from '../src/triggers/trigger-runtime.js';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';
import {
  createBenchmarkScanGate,
  type BenchmarkScanGate,
} from './support/benchmark-scan-gate.js';
import { createScheduleTriggerFixture } from './support/schedule-trigger-fixture.js';

function recordBenchmarkOperation(startedAt: number): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION_V2=${JSON.stringify({ schemaVersion: 2, name: 'schedule-to-run-start', startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population: 1, boundary: 'release verified due schedule to scanner through durable run.started observation (25ms polling)' })}\n`,
  );
}

const enabled = process.env.WORKER_TRIGGER_INTEGRATION === 'true';
const describeIntegration = enabled ? describe : describe.skip;
const fixture = createScheduleTriggerFixture();
const {
  actorId,
  apiConfig,
  apiQuery,
  authoringOptions,
  dispatcherConfig,
  ownerQuery,
  ownerQueryIn,
  redisUrl,
  releaseCohort,
  scheduleCompatibility,
  workerConfig,
  workerQuery,
  workspaceId,
} = fixture;

describeIntegration('direct Schedule worker integration gate', () => {
  let queue: Queue;
  const resources: { close(): Promise<void> }[] = [];
  let benchmarkScanGate: BenchmarkScanGate | undefined;

  function registerResource<Resource extends { close(): Promise<void> }>(
    resource: Resource,
  ): Resource {
    resources.push(resource);
    return resource;
  }

  function transferResource(resource: { close(): Promise<void> }): void {
    const index = resources.indexOf(resource);
    if (index === -1)
      throw new Error('Schedule fixture resource ownership is missing');
    resources.splice(index, 1);
  }

  beforeAll(async () => {
    await fixture.setup();
    queue = fixture.queue;
  }, 60_000);

  afterAll(async () => {
    benchmarkScanGate?.release();
    const cleanupErrors: unknown[] = [];
    const attempt = async (
      label: string,
      operation: () => void | Promise<void>,
    ): Promise<void> => {
      await Promise.resolve()
        .then(operation)
        .catch((cause: unknown) => {
          cleanupErrors.push(
            new Error(`Schedule integration cleanup failed: ${label}`, {
              cause,
            }),
          );
        });
    };
    for (const resource of resources.splice(0).reverse())
      await attempt('runtime resource', () => resource.close());
    await attempt('fixture', () => fixture.close());
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        cleanupErrors,
        'Schedule integration cleanup failed',
      );
  }, 60_000);

  it('keeps PostgreSQL authoritative through reconciliation, contention, saturation, recovery, and drain', async () => {
    const startedAt = performance.now();
    const scanErrors: unknown[] = [];
    const scanResults: unknown[] = [];
    const logger = {
      debug: () => undefined,
      error: (_event: string, _fields: unknown, error?: unknown) => {
        scanErrors.push(error);
      },
      fatal: () => undefined,
      info: () => undefined,
      trace: () => undefined,
      warn: () => undefined,
    };
    const identity = registerResource(
      createIdentityWorkspaceDatabase(apiConfig),
    );
    const compatibility = authoringOptions;
    const authoring = registerResource(
      createWorkflowAuthoringDatabase(apiConfig, compatibility.databaseOptions),
    );
    await identity.createUser({
      id: actorId,
      email: `worker-schedule-${actorId}@example.test`,
      displayName: 'Worker Schedule Owner',
    });
    await identity.createWorkspaceWithOwner({
      id: workspaceId,
      name: 'Worker Schedule Proof',
      slug: `worker-schedule-${actorId}`,
      ownerUserId: actorId,
      idempotencyKey: `worker-schedule-${actorId}`,
    });
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Direct Schedule worker proof',
      emptyGraph: { schemaVersion: 1, settings: {}, nodes: [], edges: [] },
      idempotencyKey: 'create-schedule-worker-proof',
    });
    const graph = {
      schemaVersion: 1,
      settings: {},
      nodes: [
        {
          id: 'schedule',
          definition: { key: 'core.schedule', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {
            kind: 'interval',
            intervalMinutes: 1,
            misfirePolicy: 'catch_up_once',
          },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
    };
    const draft = await authoring.saveDraft({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      representationTag: workflowDraftRepresentationTag({
        workflowId: created.workflowId,
        revision: created.draft.revision,
        graph: created.draft.graphJson,
        compatibilityFingerprint: created.draft.compatibility.fingerprint,
      }),
      expectedRevision: 1,
      graphJson: graph,
    });
    const catalog = compatibility.definitionCatalog;
    const publication = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      representationTag: workflowDraftRepresentationTag({
        workflowId: created.workflowId,
        revision: draft.revision,
        graph: draft.graphJson,
        compatibilityFingerprint: workflowCompatibilityReport(
          draft.graphJson,
          catalog,
        ).fingerprint,
      }),
      idempotencyKey: 'publish-schedule-worker-proof',
      requestHash: createHash('sha256')
        .update('publish-schedule-worker-proof')
        .digest('hex'),
    });
    const publicationEvent = await ownerQuery<{
      id: string;
      payload: Record<string, unknown>;
      payload_checksum: string;
    }>(
      `select id,payload,payload_checksum from app.outbox_events where aggregate_id=$1
        and job_name='reconcile-workflow-triggers'`,
      [created.workflowId],
    );
    const event = publicationEvent.rows[0];
    if (event === undefined) throw new Error('Publication outbox is missing');

    const runtimeScanner = registerResource(
      createScheduleTriggerScanner(
        workerConfig,
        scheduleCompatibility,
        workerConfig,
      ),
    );
    benchmarkScanGate = createBenchmarkScanGate(
      process.env.PERTEXO_Q11_OPERATION_TIMING === '1',
    );
    let runtime = registerResource(
      await createTriggerRuntime(
        {
          batchSize: 10,
          database: workerConfig,
          leaseDurationSeconds: 5,
          leaseOwner: 'schedule-runtime-one',
          pollIntervalMillis: 25,
          redisUrl,
          releaseCohort,
        },
        {
          logger,
          scanner: {
            close: () => {
              return runtimeScanner.close();
            },
            scanDue: async (input) => {
              await benchmarkScanGate?.wait(input.signal);
              if (input.signal?.aborted === true) throw input.signal.reason;
              const result = await runtimeScanner.scanDue(input);
              scanResults.push(result);
              return result;
            },
          },
        },
      ),
    );
    transferResource(runtimeScanner);
    await runtime.consumer.waitUntilReady(5_000);
    const coordinator = registerResource(
      await createCoordinatorRuntime({
        database: workerConfig,
        maximumAdmissions: 10,
        redisUrl,
        releaseCohort,
      }),
    );
    await coordinator.consumer.waitUntilReady(5_000);
    const drain = new WorkerDrainState();
    const dispatcherDatabase = registerResource(
      createOutboxDispatcherDatabase(dispatcherConfig),
    );
    const dispatcherProducer = registerResource(
      createQueueProducer({ redisUrl }),
    );
    const dispatcher = registerResource(
      new OutboxDispatcher(
        dispatcherDatabase,
        dispatcherProducer,
        drain,
        {
          batchSize: 10,
          enabledJobNames: [
            JOB_NAME.reconcileWorkflowTriggers,
            JOB_NAME.advanceWorkflowRun,
          ],
          leaseDurationMillis: 1_000,
          leaseOwner: 'schedule-publication-dispatcher',
          maxAttempts: 3,
          operationTimeoutMillis: 5_000,
          retryDelayMillis: 10,
        },
        undefined,
        createDispatchConsumerCapabilityRegistry([
          {
            jobName: JOB_NAME.reconcileWorkflowTriggers,
            consumer: runtime.consumer,
          },
          {
            jobName: JOB_NAME.advanceWorkflowRun,
            consumer: coordinator.consumer,
          },
        ]),
      ),
    );
    transferResource(dispatcherDatabase);
    transferResource(dispatcherProducer);
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 1,
    });
    await vi.waitFor(
      async () => {
        const materialized = await ownerQuery<{ count: string }>(
          `select count(*) count from app.trigger_schedules schedule
            join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
           where trigger.workflow_id=$1 and trigger.status='active'`,
          [created.workflowId],
        );
        expect(materialized.rows[0]?.count).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );
    const publicationJobId = jobIdForOutboxEvent(event.id);
    await vi.waitFor(
      async () => {
        const publicationJob = await queue.getJob(publicationJobId);
        const state = await publicationJob?.getState();
        if (state === 'failed')
          throw new Error('Publication reconciliation job failed');
        expect(state).toBe('completed');
      },
      { timeout: 5_000, interval: 25 },
    );
    const publicationJob = await queue.getJob(publicationJobId);
    await publicationJob?.remove();
    await expect(queue.getJob(publicationJobId)).resolves.toBeUndefined();
    const duplicateProducer = registerResource(
      createQueueProducer({ redisUrl }),
    );
    await duplicateProducer.waitUntilReady(5_000);
    await duplicateProducer.publish({
      name: JOB_NAME.reconcileWorkflowTriggers,
      data: {
        schemaVersion: 1,
        workspaceId,
        workflowId: created.workflowId,
        publishedVersionId: publication.version.id,
        outboxEventId: event.id,
      },
    });
    await duplicateProducer.close();
    transferResource(duplicateProducer);
    await vi.waitFor(
      async () => {
        const duplicateJob = await queue.getJob(jobIdForOutboxEvent(event.id));
        expect(await duplicateJob?.getState()).toBe('completed');
        const receipt = await workerQuery<{ count: string }>(
          `select count(*) count from app.inbox_receipts
            where consumer_name='trigger-runtime.reconciliation.v1'
              and message_id=$1 and completed_at is not null`,
          [event.id],
        );
        expect(receipt.rows[0]?.count).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );

    const trigger = await ownerQuery<{ trigger_id: string }>(
      `select schedule.trigger_id from app.trigger_schedules schedule
        join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
       where trigger.workflow_id=$1`,
      [created.workflowId],
    );
    const triggerId = trigger.rows[0]?.trigger_id;
    if (triggerId === undefined) throw new Error('Schedule trigger is missing');
    await ownerQuery(
      `with materialized as (
         delete from app.trigger_schedules where trigger_id=$1 returning *
       ) insert into app.trigger_schedules
         (trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
          interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,
          last_fire_at,status,health_status,last_error_code,created_at,updated_at,
          admission_deferred_until)
       select trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
          interval_minutes,misfire_policy,config_fingerprint,
          clock_timestamp()-interval '3 minutes',
          clock_timestamp()-interval '2 minutes',null,status,health_status,null,
          created_at,clock_timestamp(),null from materialized`,
      [triggerId],
    );
    const dueState = await ownerQuery<{
      admission_deferred_until: Date | null;
      due: boolean;
      status: string;
      trigger_status: string;
    }>(
      `select schedule.admission_deferred_until,
              schedule.next_fire_at<=clock_timestamp() due,schedule.status,
              trigger.status trigger_status
         from app.trigger_schedules schedule
         join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
        where schedule.trigger_id=$1`,
      [triggerId],
    );
    expect(dueState.rows[0]).toEqual({
      admission_deferred_until: null,
      due: true,
      status: 'enabled',
      trigger_status: 'active',
    });
    const operationStartedAt = performance.now();
    benchmarkScanGate.release();
    await vi.waitFor(
      async () => {
        const occurrences = await ownerQuery<{ count: string }>(
          'select count(*) count from app.trigger_schedule_occurrences where trigger_id=$1',
          [triggerId],
        );
        expect(
          occurrences.rows[0]?.count,
          JSON.stringify({ scanErrors, scanResults }),
        ).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );
    const first = await ownerQuery<{
      scheduled_at: Date;
      workflow_run_id: string;
    }>(
      `select scheduled_at,workflow_run_id from app.trigger_schedule_occurrences
        where trigger_id=$1`,
      [triggerId],
    );
    const firstOccurrence = first.rows[0];
    if (firstOccurrence === undefined)
      throw new Error('First schedule occurrence is missing');
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 1,
    });
    await vi.waitFor(
      async () => {
        const started = await ownerQuery<{
          event_count: string;
          status: string;
        }>(
          `select run.status,
                  count(*) filter (where event.type='run.started')::text event_count
             from app.workflow_runs run
             join app.run_events event
               on event.workspace_id=run.workspace_id
              and event.workflow_run_id=run.id
            where run.id=$1
            group by run.status`,
          [firstOccurrence.workflow_run_id],
        );
        expect(started.rows[0]?.event_count).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );
    recordBenchmarkOperation(operationStartedAt);

    await runtime.close();
    transferResource(runtime);
    const scannerOne = registerResource(
      createScheduleTriggerScanner(
        workerConfig,
        scheduleCompatibility,
        workerConfig,
      ),
    );
    const scannerTwo = registerResource(
      createScheduleTriggerScanner(
        workerConfig,
        scheduleCompatibility,
        workerConfig,
      ),
    );
    const duplicateCheckpointFactory = () => ({
      engineVersion: 'phase3-engine-v1',
      checkpoint: createCheckpoint({
        engineVersion: 'phase3-engine-v1',
        workflowVersionId: publication.version.id,
        iterationBudget: 1_000,
        nextEventSequence: 2,
      }),
    });
    await ownerQuery(
      'update app.trigger_schedules set next_fire_at=$2,last_fire_at=null where trigger_id=$1',
      [triggerId, firstOccurrence.scheduled_at],
    );
    const duplicateScans = await Promise.all([
      scannerOne.scanDue({
        leaseOwner: 'competing-scanner-one',
        limit: 1,
        leaseSeconds: 5,
        checkpointFactory: duplicateCheckpointFactory,
      }),
      scannerTwo.scanDue({
        leaseOwner: 'competing-scanner-two',
        limit: 1,
        leaseSeconds: 5,
        checkpointFactory: duplicateCheckpointFactory,
      }),
    ]);
    expect(duplicateScans.reduce((sum, scan) => sum + scan.claimed, 0)).toBe(1);
    const uniqueFacts = await workerQuery<{
      checkpoints: string;
      events: string;
      outbox: string;
      runs: string;
    }>(
      `select
        (select count(*) from app.workflow_runs where id=$1) runs,
        (select count(*) from app.run_events where workflow_run_id=$1) events,
        (select count(*) from app.run_checkpoints where workflow_run_id=$1) checkpoints,
        (select count(*) from app.outbox_events where aggregate_id=$1
          and job_name='advance-workflow-run') outbox`,
      [firstOccurrence.workflow_run_id],
    );
    expect(uniqueFacts.rows[0]).toEqual({
      runs: '1',
      events: '3',
      checkpoints: '1',
      outbox: '1',
    });

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
        emptyGraph: { schemaVersion: 1, settings: {}, nodes: [], edges: [] },
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
        pollIntervalMillis: 25,
        redisUrl,
        releaseCohort,
      }),
    );
    await runtime.consumer.waitUntilReady(5_000);
    const recoveryDatabase = registerResource(
      createOutboxDispatcherDatabase(dispatcherConfig),
    );
    const recoveryProducer = registerResource(
      createQueueProducer({ redisUrl }),
    );
    const recoveryDispatcher = registerResource(
      new OutboxDispatcher(
        recoveryDatabase,
        recoveryProducer,
        new WorkerDrainState(),
        {
          batchSize: 10,
          enabledJobNames: [JOB_NAME.reconcileWorkflowTriggers],
          leaseDurationMillis: 1_000,
          leaseOwner: 'schedule-recovery-dispatcher',
          maxAttempts: 3,
          operationTimeoutMillis: 5_000,
          retryDelayMillis: 10,
        },
        undefined,
        createDispatchConsumerCapabilityRegistry([
          {
            jobName: JOB_NAME.reconcileWorkflowTriggers,
            consumer: runtime.consumer,
          },
        ]),
      ),
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
    await apiQuery(
      `insert into app.workflow_runs
         (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
       select $2,workspace_id,workflow_id,workflow_version_id,'manual','queued'
         from app.workflow_runs where id=$1`,
      [firstOccurrence.workflow_run_id, quotaOccupantRunId],
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
      pollIntervalMillis: 25,
      redisUrl,
      releaseCohort,
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
    expect(event.payload_checksum).toBe(
      canonicalOutboxPayloadChecksum(event.payload),
    );
    console.info(
      `Schedule worker integration completed in ${String(Math.round(performance.now() - startedAt))}ms`,
    );
  }, 30_000);
});
