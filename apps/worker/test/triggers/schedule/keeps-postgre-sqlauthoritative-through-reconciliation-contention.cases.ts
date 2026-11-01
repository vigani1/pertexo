import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import { createScheduleTriggerScanner } from '@pertexo/core/testing';
import {
  createQueueProducer,
  JOB_NAME,
  jobIdForOutboxEvent,
} from '@pertexo/queue';
import { createCheckpoint } from '@pertexo/workflow-engine';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';

import { expect, it, vi } from 'vitest';

import {
  recordBenchmarkOperation,
  ownerQuery,
  redisUrl,
  workerConfig,
  workerQuery,
  workspaceId,
  queue,
  registerResource,
  transferResource,
} from './fixture.js';
import { seedScheduleQualification } from './execution/seed.js';
import { startScheduleQualification } from './execution/runtime.js';
import { assertScheduleQuotaRecovery } from './execution/quota.js';

export function registerKeepsPostgreSQLAuthoritativeThroughReconciliationContention(): void {
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
    const { identity, authoring, created, graph, catalog, publication } =
      await seedScheduleQualification();
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

    const { runtime, dispatcher, scanGate } = await startScheduleQualification({
      logger,
      scanResults,
    });
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
            where consumer_name='trigger-runtime.reconciliation'
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
    scanGate.release();
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
      createScheduleTriggerScanner(workerConfig, workerConfig),
    );
    const scannerTwo = registerResource(
      createScheduleTriggerScanner(workerConfig, workerConfig),
    );
    const duplicateCheckpointFactory = () => ({
      checkpoint: createCheckpoint({
        workflowVersionId: publication.version.id,
        iterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
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
        onTimeWindowSeconds: 300,
        checkpointFactory: duplicateCheckpointFactory,
      }),
      scannerTwo.scanDue({
        leaseOwner: 'competing-scanner-two',
        limit: 1,
        leaseSeconds: 5,
        onTimeWindowSeconds: 300,
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

    await assertScheduleQuotaRecovery({
      identity,
      authoring,
      graph,
      catalog,
      runtime,
      firstOccurrence,
      triggerId,
    });
    expect(event.payload_checksum).toBe(
      canonicalOutboxPayloadChecksum(event.payload),
    );
    console.info(
      `Schedule worker integration completed in ${String(Math.round(performance.now() - startedAt))}ms`,
    );
  }, 30_000);
}
