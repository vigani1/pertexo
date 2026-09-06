import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createWorkflowLifecycleWorkerEnvironment,
  workflowLifecycleIntegrationRedisUrl,
  workflowLifecycleIntegrationEnabled,
  type LifecycleIds,
  type LifecycleOutboxEvent,
  type LifecycleProjection,
  type RunSnapshot,
  type WorkflowLifecycleWorkerEnvironment,
} from './support/workflow-lifecycle.integration.support.js';
import {
  JOB_NAME,
  jobIdForOutboxEvent,
} from './support/workflow-lifecycle.integration.support.js';
import { createQueueProducer, type QueueConsumer } from '@pertexo/queue';

const describeIntegration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;

describeIntegration(
  'workflow lifecycle dispatcher and worker convergence',
  () => {
    let environment: WorkflowLifecycleWorkerEnvironment | undefined;

    beforeAll(async () => {
      environment = createWorkflowLifecycleWorkerEnvironment();
      await environment.initialize();
    }, 60_000);

    afterAll(async () => {
      if (environment !== undefined) await environment.close();
    }, 60_000);

    it('converges archive/restore through BullMQ, survives restart, and preserves durable state', async () => {
      if (environment === undefined)
        throw new Error('Worker fixture is missing');
      const { ids } = environment;
      const initialRun = await environment.readRunSnapshot();
      expectRunSnapshotIsNonEmpty(initialRun);

      const firstRuntime = await environment.createRuntime(
        'workflow-lifecycle-worker-first',
      );
      const archive = await environment.transition(
        'archive',
        1,
        'workflow-lifecycle-archive-one',
      );
      expect(archive).toMatchObject({
        replayed: false,
        workflow: {
          lifecycleStatus: 'archived',
          lifecycleRevision: 2,
          activationStatus: 'deactivating',
          publishedVersionId: ids.version,
        },
      });
      const archiveEvent = await eventForTransition(
        environment,
        archive.workflow,
      );
      const archiveDispatcher = environment.createDispatcher(
        'workflow-lifecycle-dispatcher-archive-one',
        capabilityFor(firstRuntime.consumer),
      );
      await expect(archiveDispatcher.dispatchOnce()).resolves.toMatchObject({
        claimed: 1,
        published: 1,
      });
      await waitForQueueJob(environment, archiveEvent.id);
      await waitForProjection(environment, (projection) => {
        expect(projection.workflow).toEqual({
          lifecycleStatus: 'archived',
          lifecycleRevision: 2,
          activationStatus: 'inactive',
          publishedVersionId: ids.version,
        });
        expect(resourceStatuses(projection, ids)).toEqual({
          activeWebhook: 'disabled',
          activeSchedule: 'disabled',
          disabledWebhook: 'disabled',
          disabledSchedule: 'disabled',
          activeWebhookEndpoint: 'active',
          disabledWebhookEndpoint: 'disabled',
          activeScheduleRow: 'enabled',
          disabledScheduleRow: 'disabled',
        });
      });
      await waitForReceipt(environment, archiveEvent.id);
      expect(await environment.readRunSnapshot()).toEqual(initialRun);

      await firstRuntime.close();
      const restore = await environment.transition(
        'restore',
        2,
        'workflow-lifecycle-restore-one',
      );
      expect(restore).toMatchObject({
        replayed: false,
        workflow: {
          lifecycleStatus: 'active',
          lifecycleRevision: 3,
          activationStatus: 'activating',
          publishedVersionId: ids.version,
        },
      });
      const restoreEvent = await eventForTransition(
        environment,
        restore.workflow,
      );
      const stoppedDispatcher = environment.createDispatcher(
        'workflow-lifecycle-dispatcher-restore-one-stopped-worker',
        environment.readyCapabilities(),
      );
      await expect(stoppedDispatcher.dispatchOnce()).resolves.toMatchObject({
        claimed: 1,
        published: 1,
      });

      // The event is already durable in Redis while the first worker is closed.
      // A newly constructed runtime must consume it and rebuild the projection.
      const restartedRuntime = await environment.createRuntime(
        'workflow-lifecycle-worker-restarted',
      );
      await waitForProjection(environment, (projection) => {
        expect(projection.workflow).toEqual({
          lifecycleStatus: 'active',
          lifecycleRevision: 3,
          activationStatus: 'degraded',
          publishedVersionId: ids.version,
        });
        expect(resourceStatuses(projection, ids)).toEqual({
          activeWebhook: 'active',
          activeSchedule: 'active',
          disabledWebhook: 'disabled',
          disabledSchedule: 'disabled',
          activeWebhookEndpoint: 'active',
          disabledWebhookEndpoint: 'disabled',
          activeScheduleRow: 'enabled',
          disabledScheduleRow: 'disabled',
        });
      });
      await waitForQueueJob(environment, restoreEvent.id);
      await waitForReceipt(environment, restoreEvent.id);
      expect(await environment.readRunSnapshot()).toEqual(initialRun);

      // Remove only the completed BullMQ record so the exact same durable event
      // can be delivered again. The inbox receipt makes the duplicate a no-op.
      const beforeDuplicate = await environment.readProjection();
      await environment.queue.remove(jobIdForOutboxEvent(restoreEvent.id));
      const duplicateProducer = createQueueProducer({
        redisUrl: workflowLifecycleIntegrationRedisUrl,
      });
      try {
        await duplicateProducer.waitUntilReady(5_000);
        await duplicateProducer.publish({
          name: JOB_NAME.reconcileWorkflowTriggers,
          data: restoreEvent.payload,
        });
      } finally {
        await duplicateProducer.close();
      }
      await waitForQueueJob(environment, restoreEvent.id);
      await waitForReceipt(environment, restoreEvent.id);
      expect(await environment.readProjection()).toEqual(beforeDuplicate);
      expect(await receiptCount(environment, restoreEvent.id)).toBe(1);
      expect(await environment.readRunSnapshot()).toEqual(initialRun);

      // A second archive is intentionally held back. Restore is dispatched first,
      // then the older archive event is delivered. PostgreSQL lifecycle authority
      // must make that reordered archive reconcile the current active state.
      const archiveTwo = await environment.transition(
        'archive',
        3,
        'workflow-lifecycle-archive-two',
      );
      const archiveTwoEvent = await eventForTransition(
        environment,
        archiveTwo.workflow,
      );
      await environment.ownerQuery(
        `update app.outbox_events
          set available_at=clock_timestamp()+interval '1 hour'
        where id=$1`,
        [archiveTwoEvent.id],
      );
      const restoreTwo = await environment.transition(
        'restore',
        4,
        'workflow-lifecycle-restore-two',
      );
      const restoreTwoEvent = await eventForTransition(
        environment,
        restoreTwo.workflow,
      );
      const restoreTwoDispatcher = environment.createDispatcher(
        'workflow-lifecycle-dispatcher-restore-two',
        capabilityFor(restartedRuntime.consumer),
      );
      await expect(restoreTwoDispatcher.dispatchOnce()).resolves.toMatchObject({
        claimed: 1,
        published: 1,
      });
      await waitForQueueJob(environment, restoreTwoEvent.id);
      await waitForReceipt(environment, restoreTwoEvent.id);
      const beforeReorderedArchive = await environment.readProjection();
      expect(beforeReorderedArchive.workflow.activationStatus).toBe('degraded');

      await environment.makeDue(archiveTwoEvent.id);
      const reorderedDispatcher = environment.createDispatcher(
        'workflow-lifecycle-dispatcher-archive-two-reordered',
        capabilityFor(restartedRuntime.consumer),
      );
      await expect(reorderedDispatcher.dispatchOnce()).resolves.toMatchObject({
        claimed: 1,
        published: 1,
      });
      await waitForQueueJob(environment, archiveTwoEvent.id);
      await waitForReceipt(environment, archiveTwoEvent.id);
      expect(await environment.readProjection()).toEqual(
        beforeReorderedArchive,
      );
      expect(await environment.readRunSnapshot()).toEqual(initialRun);
    });
  },
);

function capabilityFor(
  consumer: Pick<QueueConsumer, 'isReady' | 'waitUntilReady'>,
) {
  return {
    assertReady: async (): Promise<void> => {
      await consumer.waitUntilReady(5_000);
      if (!consumer.isReady()) throw new Error('lifecycle worker is not ready');
    },
    readyJobNames: () => [JOB_NAME.reconcileWorkflowTriggers] as const,
  };
}

function expectRunSnapshotIsNonEmpty(snapshot: RunSnapshot): void {
  for (const status of ['queued', 'running', 'waiting', 'succeeded'] as const) {
    const run = JSON.parse(snapshot.runs[status]) as { status?: unknown };
    expect(run.status).toBe(status);
    expect(snapshot.events[status].length).toBeGreaterThan(0);
    expect(snapshot.checkpoints[status]).not.toBe('');
  }
}

async function eventForTransition(
  environment: WorkflowLifecycleWorkerEnvironment,
  workflow: Readonly<{ lifecycleRevision: number }>,
): Promise<LifecycleOutboxEvent> {
  const result = await environment.ownerQuery<{
    id: string;
    payload: LifecycleOutboxEvent['payload'];
  }>(
    `select id,payload from app.outbox_events
       where aggregate_id=$1 and job_name=$2
       order by created_at desc,id desc limit 1`,
    [environment.ids.workflow, JOB_NAME.reconcileWorkflowTriggers],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error(
      `Lifecycle event for revision ${String(workflow.lifecycleRevision)} is missing`,
    );
  return row;
}

async function waitForProjection(
  environment: WorkflowLifecycleWorkerEnvironment,
  assertion: (projection: LifecycleProjection) => void,
): Promise<void> {
  await poll('workflow lifecycle projection', async () => {
    assertion(await environment.readProjection());
  });
}

async function waitForReceipt(
  environment: WorkflowLifecycleWorkerEnvironment,
  eventId: string,
): Promise<void> {
  await poll('workflow lifecycle inbox receipt', async () => {
    const result = await environment.workerQuery<{ completed_at: Date | null }>(
      `select completed_at from app.inbox_receipts
         where consumer_name='trigger-runtime.reconciliation.v1' and message_id=$1`,
      [eventId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.completed_at).toBeInstanceOf(Date);
  });
}

async function waitForQueueJob(
  environment: WorkflowLifecycleWorkerEnvironment,
  eventId: string,
): Promise<void> {
  await poll('workflow lifecycle BullMQ job', async () => {
    const job = await environment.queue.getJob(jobIdForOutboxEvent(eventId));
    if (job === undefined) throw new Error('BullMQ job is missing');
    expect(await job.getState()).toBe('completed');
  });
}

async function receiptCount(
  environment: WorkflowLifecycleWorkerEnvironment,
  eventId: string,
): Promise<number> {
  const result = await environment.workerQuery<{ count: string }>(
    `select count(*)::text count from app.inbox_receipts
       where consumer_name='trigger-runtime.reconciliation.v1' and message_id=$1`,
    [eventId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

function resourceStatuses(projection: LifecycleProjection, ids: LifecycleIds) {
  const trigger = (id: string) => {
    const row = projection.triggers.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error(`Trigger ${id} is missing`);
    return row.status;
  };
  const endpoint = (id: string) => {
    const row = projection.endpoints.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error(`Endpoint ${id} is missing`);
    return row.status;
  };
  const schedule = (triggerId: string) => {
    const row = projection.schedules.find(
      (candidate) => candidate.triggerId === triggerId,
    );
    if (row === undefined) throw new Error(`Schedule ${triggerId} is missing`);
    return row.status;
  };
  return {
    activeWebhook: trigger(ids.activeWebhook),
    activeSchedule: trigger(ids.activeSchedule),
    disabledWebhook: trigger(ids.disabledWebhook),
    disabledSchedule: trigger(ids.disabledSchedule),
    activeWebhookEndpoint: endpoint(ids.activeWebhookEndpoint),
    disabledWebhookEndpoint: endpoint(ids.disabledWebhookEndpoint),
    activeScheduleRow: schedule(ids.activeSchedule),
    disabledScheduleRow: schedule(ids.disabledSchedule),
  };
}

async function poll(
  label: string,
  assertion: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`${label} did not converge`, { cause: lastError });
}
