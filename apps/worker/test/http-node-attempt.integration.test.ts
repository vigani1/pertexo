import { createHash, randomUUID } from 'node:crypto';

import { JOB_NAME } from '@pertexo/queue';
import type { QueueProducer } from '@pertexo/queue';
import {
  canonicalOutboxPayloadChecksum,
  createNodeAttemptRunStore,
  type NodeAttemptLease,
} from '@pertexo/database/execution';
import {
  createOperatorCommandDatabase,
  parseOperatorDatabaseConfig,
} from '@pertexo/database/operator';
import {
  NodeAttemptReconciliationRequiredError,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import type { Queue } from 'bullmq';
import { beforeAll, describe, expect, it } from 'vitest';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

import { createHttpNodeAttemptProofRuntime } from './support/http-node-attempt.runtime.js';
import { createDatabaseOperatorRunReplayStore } from '../src/execution/operator-run-replay-runtime.js';

import {
  acceptRun,
  acceptProviderScenarioRun,
  actorId,
  attemptDelivery,
  connectionDatabase,
  connectionId,
  continuation,
  cancelProviderScenarioRun,
  databaseUrl,
  emailConnectionId,
  emailRecipient,
  emailSecretVersionId,
  emailSubject,
  emailText,
  expireProviderScenarioRun,
  installHttpNodeAttemptFixture,
  httpNodeAttemptIntegrationEnabled,
  plaintextSecret,
  operatorUrl,
  reclaimProviderScenarioAttempt,
  resendApiKey,
  responseBytes,
  rotatedEmailSecretVersionId,
  rotatedResendApiKey,
  seedFixture,
  slackBotToken,
  slackConnectionId,
  slackMessageText,
  waitFor,
  withOwner,
  workerQuery,
  workerUrl,
  workspaceId,
} from './support/http-node-attempt.fixture.js';

installHttpNodeAttemptFixture();

const describeIntegration = httpNodeAttemptIntegrationEnabled
  ? describe
  : describe.skip;

let fixtureEncryption: Awaited<ReturnType<typeof seedFixture>> | undefined;

type PersistedQueueJob = NonNullable<Awaited<ReturnType<Queue['getJob']>>>;
type ProofRuntime = Awaited<
  ReturnType<typeof createHttpNodeAttemptProofRuntime>
>;

async function publishAndWaitForCompletion(
  producer: QueueProducer,
  queue: Queue,
  job: Parameters<QueueProducer['publish']>[0],
  label: string,
): Promise<PersistedQueueJob> {
  const published = await producer.publish(job);
  const persisted = await waitFor(
    () => queue.getJob(published.jobId),
    (candidate) => candidate !== undefined,
  );
  if (persisted === undefined)
    throw new Error(`${label} job was not persisted`);
  await waitFor(
    () => persisted.getState(),
    (state) => state === 'completed' || state === 'failed',
  );
  const state = await persisted.getState();
  if (state !== 'completed') {
    const refreshed = await queue.getJob(published.jobId);
    throw new Error(
      `${label} job ${state}: ${refreshed?.failedReason ?? 'unknown reason'}`,
    );
  }
  return persisted;
}

function attemptJob(
  runId: string,
  attempt: Awaited<ReturnType<typeof attemptDelivery>>,
) {
  return {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      schemaVersion: 1 as const,
      workspaceId,
      runId,
      nodeRunId: attempt.node_run_id,
      attemptId: attempt.attempt_id,
      outboxEventId: attempt.outbox_id,
    },
  };
}

async function admitProviderScenario(
  runtime: ProofRuntime,
  provider: 'email' | 'http' | 'slack',
) {
  const accepted = await acceptProviderScenarioRun(provider);
  const coordinatorOutboxes = [accepted.outboxEventId];
  await Promise.all([
    runtime.coordinator.consumer.waitUntilReady(5_000),
    runtime.attempts.consumer.waitUntilReady(5_000),
    runtime.producer.waitUntilReady(5_000),
  ]);
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.coordinatorQueue,
    {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId,
        runId: accepted.runId,
        outboxEventId: accepted.outboxEventId,
      },
    },
    `${provider} scenario initial coordinator`,
  );
  const manual = await attemptDelivery(accepted.runId, 'manual');
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.attemptQueue,
    attemptJob(accepted.runId, manual),
    `${provider} scenario manual attempt`,
  );
  const admissionOutbox = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(admissionOutbox);
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.coordinatorQueue,
    {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId,
        runId: accepted.runId,
        outboxEventId: admissionOutbox,
      },
    },
    `${provider} scenario provider admission`,
  );
  return {
    accepted,
    attempt: await attemptDelivery(accepted.runId, 'provider'),
    coordinatorOutboxes,
  };
}

async function advanceScenario(
  runtime: ProofRuntime,
  runId: string,
  coordinatorOutboxes: string[],
  label: string,
): Promise<void> {
  const outboxEventId = await continuation(runId, coordinatorOutboxes);
  coordinatorOutboxes.push(outboxEventId);
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.coordinatorQueue,
    {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId,
        runId,
        outboxEventId,
      },
    },
    label,
  );
}

async function prepareAmbiguousEmailRetry(runtime: ProofRuntime) {
  const scenario = await admitProviderScenario(runtime, 'email');
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.attemptQueue,
    attemptJob(scenario.accepted.runId, scenario.attempt),
    'Initial ambiguous email attempt',
  );
  await advanceScenario(
    runtime,
    scenario.accepted.runId,
    scenario.coordinatorOutboxes,
    'Ambiguous email retry decision',
  );
  const retryDue = await waitFor(
    () =>
      workerQuery<{ retry_due_at: Date | null }>(
        `select retry_due_at from app.node_runs
           where workspace_id=$1 and workflow_run_id=$2 and node_id='provider'`,
        [workspaceId, scenario.accepted.runId],
      ),
    (rows) => rows[0]?.retry_due_at instanceof Date,
  );
  const retryDueAt = retryDue[0]?.retry_due_at;
  if (retryDueAt === null || retryDueAt === undefined)
    throw new Error('Ambiguous email retry due time missing');
  const delayMillis = retryDueAt.getTime() - Date.now();
  if (delayMillis > 0)
    await new Promise<void>((resolve) => setTimeout(resolve, delayMillis + 25));
  await advanceScenario(
    runtime,
    scenario.accepted.runId,
    scenario.coordinatorOutboxes,
    'Ambiguous email retry due admission',
  );
  return {
    ...scenario,
    retry: await attemptDelivery(scenario.accepted.runId, 'provider', 2),
  };
}

async function closeProofRuntime(runtime: ProofRuntime): Promise<void> {
  await Promise.allSettled([
    runtime.attempts.close(),
    runtime.coordinator.close(),
    runtime.producer.close(),
    runtime.attemptQueue.close(),
    runtime.coordinatorQueue.close(),
    runtime.capabilities.close(),
  ]);
  runtime.artifactVerifier.close();
}

beforeAll(async () => {
  fixtureEncryption = await seedFixture();
});

describeIntegration('active HTTP node attempt', () => {
  it('commits artifact, attempt truth, audit, bounded telemetry, and inert exact redelivery without leaking credentials', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    const accepted = await acceptRun();
    const {
      artifactVerifier,
      attemptQueue,
      attempts,
      capabilities,
      coordinator,
      coordinatorQueue,
      emailRequests,
      producer,
      slackRequests,
      telemetry,
      transportRequests,
    } = await createHttpNodeAttemptProofRuntime(encryption);
    const coordinatorOutboxes = [accepted.outboxEventId];
    let persistedArtifactId: string | undefined;
    try {
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const initialCoordinatorJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: accepted.outboxEventId,
        },
      });
      const persistedInitialJob = await waitFor(
        () => coordinatorQueue.getJob(initialCoordinatorJob.jobId),
        (job) => job !== undefined,
      );
      if (persistedInitialJob === undefined)
        throw new Error('Initial coordinator job missing');
      await waitFor(
        () => persistedInitialJob.getState(),
        (state) => state === 'completed' || state === 'failed',
      );
      if ((await persistedInitialJob.getState()) === 'failed')
        throw new Error(
          `Initial coordinator job failed: ${persistedInitialJob.failedReason}`,
        );

      const manual = await attemptDelivery(accepted.runId, 'manual');
      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: manual.node_run_id,
          attemptId: manual.attempt_id,
          outboxEventId: manual.outbox_id,
        },
      });
      const firstContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(firstContinuation);
      const httpAdmission = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: firstContinuation,
        },
      });
      const admissionJob = await waitFor(
        () => coordinatorQueue.getJob(httpAdmission.jobId),
        (job) => job !== undefined,
      );
      if (admissionJob === undefined)
        throw new Error('HTTP admission job missing');
      await waitFor(
        () => admissionJob.getState(),
        (state) => state === 'completed' || state === 'failed',
      );
      if ((await admissionJob.getState()) === 'failed')
        throw new Error(
          `HTTP admission failed: ${JSON.stringify(await coordinatorQueue.getJob(httpAdmission.jobId))}`,
        );

      const http = await attemptDelivery(accepted.runId, 'http');
      const delivery = {
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: http.node_run_id,
          attemptId: http.attempt_id,
          outboxEventId: http.outbox_id,
        },
      };
      const published = await producer.publish(delivery);
      const terminal = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            node_status: string;
            output_ref: unknown;
            attempt_provider_key: string | null;
            attempt_side_effect_class: string;
            node_provider_key: string | null;
            node_side_effect_class: string;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    node.status node_status,attempt.output_ref,
                    attempt.side_effect_class attempt_side_effect_class,
                    attempt.provider_idempotency_key attempt_provider_key,
                    node.side_effect_class node_side_effect_class,
                    node.provider_idempotency_key node_provider_key
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, http.attempt_id],
          ),
        (rows) => rows[0]?.attempt_status === 'succeeded',
      );
      expect(terminal[0]).toMatchObject({
        attempt_status: 'succeeded',
        attempt_provider_key: null,
        attempt_side_effect_class: 'unsafe',
        node_status: 'succeeded',
        node_provider_key: null,
        node_side_effect_class: 'unsafe',
      });
      expect(terminal[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(terminal[0]?.output_ref).toMatchObject({
        kind: 'inline',
        value: {
          status: 200,
          body: { kind: 'artifact', byteLength: responseBytes },
        },
      });
      const artifactId = (
        terminal[0]?.output_ref as {
          value: { body: { artifactId: string } };
        }
      ).value.body.artifactId;
      persistedArtifactId = artifactId;
      const expectedArtifact = Buffer.concat([
        Buffer.alloc(35_000, 7),
        Buffer.alloc(35_000, 9),
      ]);
      const artifactStream = await artifactVerifier.getStream({
        artifactId,
        workspaceId,
      });
      const artifactChunks: Buffer[] = [];
      for await (const chunk of artifactStream.body) {
        if (!(chunk instanceof Uint8Array))
          throw new TypeError('HTTP artifact chunk is not bytes');
        artifactChunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(artifactChunks)).toEqual(expectedArtifact);
      expect(transportRequests).toHaveLength(1);
      expect(transportRequests[0]?.headers.authorization).toBe(plaintextSecret);

      const durable = await workerQuery<{
        artifact_count: string;
        event_types: string[];
        inbox_completed: string;
        inbox_count: string;
        usage_count: string;
      }>(
        `select
          (select count(*)::text from app.artifacts artifact
            where artifact.workspace_id=$1 and artifact.id=$3
              and artifact.status='available' and artifact.byte_length=$4
              and artifact.sha256=$6) artifact_count,
          (select count(*)::text from app.inbox_receipts receipt
            where receipt.workspace_id=$1 and receipt.message_id=$5
              and receipt.consumer_name='node-attempt-worker') inbox_count,
          (select count(receipt.completed_at)::text from app.inbox_receipts receipt
            where receipt.workspace_id=$1 and receipt.message_id=$5
              and receipt.consumer_name='node-attempt-worker') inbox_completed,
          (select count(*)::text from app.usage_events usage
            where usage.workspace_id=$1 and usage.resource_id=$2) usage_count,
          (select array_agg(type order by sequence) from app.run_events event
            where event.workspace_id=$1 and event.workflow_run_id=$2) event_types`,
        [
          workspaceId,
          accepted.runId,
          artifactId,
          responseBytes,
          http.outbox_id,
          createHash('sha256').update(expectedArtifact).digest('hex'),
        ],
      );
      const audit = await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
           where workspace_id=$1 and connection_id=$2
             and event_type='connection.credential_accessed'
             and actor_kind='worker'`,
          [workspaceId, connectionId],
        ),
      );
      expect(audit.rows[0]?.count).toBe('1');
      expect(durable[0]).toEqual({
        artifact_count: '1',
        event_types: [
          'run.queued',
          'run.started',
          'node.ready',
          'node.started',
          'node.succeeded',
          'node.ready',
          'node.started',
          'node.succeeded',
        ],
        inbox_completed: '1',
        inbox_count: '1',
        usage_count: '0',
      });

      expect(telemetry).toHaveLength(3);
      expect(telemetry.map(({ kind, name }) => ({ kind, name }))).toEqual([
        { kind: 'count', name: 'pertexo.provider.request.count' },
        { kind: 'duration', name: 'pertexo.provider.request.duration' },
        { kind: 'span', name: 'pertexo.provider.http.request' },
      ]);
      for (const record of telemetry)
        expect(record.attributes).toEqual({
          provider_key: 'http',
          operation_key: 'request',
          outcome: 'succeeded',
          possibly_dispatched: true,
          response_storage: 'artifact',
          status_class: '2xx',
        });

      const completedJob = await waitFor(
        () => attemptQueue.getJob(published.jobId),
        (job) => job !== undefined,
      );
      if (completedJob === undefined) throw new Error('HTTP job missing');
      await waitFor(
        () => completedJob.getState(),
        (state) => state === 'completed',
      );
      const beforeRedelivery = await workerQuery<{ fact: string }>(
        `select concat_ws('|',attempt.status,attempt.fence_token,
                           attempt.dispatch_marked_at,attempt.output_ref::text,
                           attempt.side_effect_class,attempt.provider_idempotency_key,
                           node.status,node.output_ref::text,
                           node.side_effect_class,node.provider_idempotency_key,
                           (select count(*) from app.run_events event
                            where event.workspace_id=attempt.workspace_id
                              and event.workflow_run_id=$2),
                           (select count(*) from app.inbox_receipts receipt
                             where receipt.workspace_id=attempt.workspace_id
                               and receipt.message_id=$3),
                           (select count(*) from app.usage_events usage
                             where usage.workspace_id=attempt.workspace_id
                               and usage.resource_id=$2),
                           (select count(*) from app.artifacts artifact
                             where artifact.workspace_id=attempt.workspace_id
                               and artifact.id=$5)) fact
         from app.node_attempts attempt
         join app.node_runs node
           on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
         where attempt.workspace_id=$1 and attempt.id=$4`,
        [
          workspaceId,
          accepted.runId,
          http.outbox_id,
          http.attempt_id,
          artifactId,
        ],
      );
      await completedJob.remove();
      await producer.publish(delivery);
      const replay = await waitFor(
        () => attemptQueue.getJob(published.jobId),
        (job) => job !== undefined,
      );
      if (replay === undefined) throw new Error('redelivered HTTP job missing');
      await waitFor(
        () => replay.getState(),
        (state) => state === 'completed',
      );
      await expect(
        workerQuery<{ fact: string }>(
          `select concat_ws('|',attempt.status,attempt.fence_token,
                             attempt.dispatch_marked_at,attempt.output_ref::text,
                             attempt.side_effect_class,attempt.provider_idempotency_key,
                             node.status,node.output_ref::text,
                             node.side_effect_class,node.provider_idempotency_key,
                            (select count(*) from app.run_events event
                              where event.workspace_id=attempt.workspace_id
                                and event.workflow_run_id=$2),
                             (select count(*) from app.inbox_receipts receipt
                               where receipt.workspace_id=attempt.workspace_id
                                 and receipt.message_id=$3),
                             (select count(*) from app.usage_events usage
                               where usage.workspace_id=attempt.workspace_id
                                 and usage.resource_id=$2),
                             (select count(*) from app.artifacts artifact
                               where artifact.workspace_id=attempt.workspace_id
                                 and artifact.id=$5)) fact
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and attempt.id=$4`,
          [
            workspaceId,
            accepted.runId,
            http.outbox_id,
            http.attempt_id,
            artifactId,
          ],
        ),
      ).resolves.toEqual(beforeRedelivery);
      expect(transportRequests).toHaveLength(1);
      expect(telemetry).toHaveLength(3);
      const auditAfterRedelivery = await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
           where workspace_id=$1 and connection_id=$2
             and event_type='connection.credential_accessed'
             and actor_kind='worker'`,
          [workspaceId, connectionId],
        ),
      );
      expect(auditAfterRedelivery.rows).toEqual(audit.rows);

      const slackContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(slackContinuation);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: slackContinuation,
        },
      });
      const slack = await attemptDelivery(accepted.runId, 'slack');
      const slackDelivery = {
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: slack.node_run_id,
          attemptId: slack.attempt_id,
          outboxEventId: slack.outbox_id,
        },
      };
      const slackJob = await producer.publish(slackDelivery);
      const slackTerminal = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            executor_error_kind: string | null;
            executor_failure_kind: string | null;
            error_summary: string | null;
            node_status: string;
            output_ref: unknown;
            safe_error_code: string | null;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.executor_error_kind,attempt.executor_failure_kind,
                    attempt.error_summary,
                    attempt.safe_error_code,node.status node_status,attempt.output_ref
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, slack.attempt_id],
          ),
        (rows) => rows[0]?.attempt_status === 'succeeded',
      );
      expect(slackTerminal[0]).toMatchObject({
        attempt_status: 'succeeded',
        node_status: 'succeeded',
        output_ref: {
          kind: 'inline',
          value: {
            channelId: 'C123ABC',
            messageTs: '1724412345.000100',
          },
        },
      });
      expect(slackTerminal[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(slackRequests).toEqual([
        {
          botToken: slackBotToken,
          channelId: 'C123ABC',
          text: slackMessageText,
        },
      ]);
      const slackAudit = await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
           where workspace_id=$1 and connection_id=$2
             and event_type='connection.credential_accessed'
             and actor_kind='worker'`,
          [workspaceId, slackConnectionId],
        ),
      );
      expect(slackAudit.rows[0]?.count).toBe('1');
      const completedSlackJob = await waitFor(
        () => attemptQueue.getJob(slackJob.jobId),
        (job) => job !== undefined,
      );
      if (completedSlackJob === undefined) throw new Error('Slack job missing');
      await waitFor(
        () => completedSlackJob.getState(),
        (state) => state === 'completed',
      );
      await completedSlackJob.remove();
      await producer.publish(slackDelivery);
      const replayedSlackJob = await waitFor(
        () => attemptQueue.getJob(slackJob.jobId),
        (job) => job !== undefined,
      );
      if (replayedSlackJob === undefined)
        throw new Error('redelivered Slack job missing');
      await waitFor(
        () => replayedSlackJob.getState(),
        (state) => state === 'completed',
      );
      expect(slackRequests).toHaveLength(1);

      const emailContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(emailContinuation);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: emailContinuation,
        },
      });
      const email = await attemptDelivery(accepted.runId, 'email');
      const emailDelivery = {
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: email.node_run_id,
          attemptId: email.attempt_id,
          outboxEventId: email.outbox_id,
        },
      };
      const emailJob = await producer.publish(emailDelivery);
      const firstEmailAttempt = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            executor_failure_kind: string | null;
            executor_possibly_dispatched: boolean | null;
            node_status: string;
            output_ref: unknown;
            provider_dispatch_binding: string | null;
            provider_idempotency_key: string | null;
            retry_decision: string | null;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                     attempt.provider_idempotency_key,node.status node_status,
                     node.provider_dispatch_binding,
                     attempt.output_ref,attempt.executor_failure_kind,
                     attempt.executor_possibly_dispatched,
                     attempt.retry_decision
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, email.attempt_id],
          ),
        (rows) => rows[0]?.attempt_status === 'failed',
      );
      expect(firstEmailAttempt[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(firstEmailAttempt[0]?.executor_failure_kind).toBe('retry');
      expect(firstEmailAttempt[0]?.executor_possibly_dispatched).toBe(false);
      expect(firstEmailAttempt[0]?.retry_decision).toBe('pending');
      const retryContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(retryContinuation);
      const retryCoordinatorJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: retryContinuation,
        },
      });
      const persistedRetryCoordinatorJob = await waitFor(
        () => coordinatorQueue.getJob(retryCoordinatorJob.jobId),
        (job) => job !== undefined,
      );
      if (persistedRetryCoordinatorJob === undefined)
        throw new Error('Email retry coordinator job missing');
      await waitFor(
        () => persistedRetryCoordinatorJob.getState(),
        (state) => state === 'completed',
      );
      await waitFor(
        () =>
          workerQuery<{ retry_decision: string | null }>(
            `select retry_decision from app.node_attempts
             where workspace_id=$1 and id=$2`,
            [workspaceId, email.attempt_id],
          ),
        (rows) => rows[0]?.retry_decision === 'retry',
      );
      const dueContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(dueContinuation);
      const dueCoordinatorJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: dueContinuation,
        },
      });
      const persistedDueCoordinatorJob = await waitFor(
        () => coordinatorQueue.getJob(dueCoordinatorJob.jobId),
        (job) => job !== undefined,
      );
      if (persistedDueCoordinatorJob === undefined)
        throw new Error('Email due coordinator job missing');
      await waitFor(
        () => persistedDueCoordinatorJob.getState(),
        (state) => state === 'completed',
      );
      const retriedEmail = await attemptDelivery(accepted.runId, 'email', 2);
      const retriedEmailDelivery = {
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: retriedEmail.node_run_id,
          attemptId: retriedEmail.attempt_id,
          outboxEventId: retriedEmail.outbox_id,
        },
      };
      const retriedEmailJob = await producer.publish(retriedEmailDelivery);
      const emailTerminal = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            node_status: string;
            output_ref: unknown;
            provider_dispatch_binding: string | null;
            provider_idempotency_key: string | null;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.provider_idempotency_key,node.status node_status,
                    node.provider_dispatch_binding,
                    attempt.output_ref
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, retriedEmail.attempt_id],
          ),
        (rows) => rows[0]?.attempt_status === 'succeeded',
      );
      expect(emailTerminal[0]).toMatchObject({
        attempt_status: 'succeeded',
        node_status: 'succeeded',
        output_ref: {
          kind: 'inline',
          value: { emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' },
        },
      });
      expect(emailTerminal[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(emailTerminal[0]?.provider_idempotency_key).toMatch(
        /^v1\.[0-9a-f]{64}$/u,
      );
      expect(emailTerminal[0]?.provider_dispatch_binding).toBe(
        `email:v1:sha256:${createHash('sha256')
          .update(`email\0${emailConnectionId}\0${emailSecretVersionId}`)
          .digest('hex')}`,
      );
      expect(emailTerminal[0]?.provider_dispatch_binding).not.toContain(
        'sender@example.test',
      );
      expect(emailRequests).toHaveLength(2);
      expect(emailRequests[0]).toEqual({
        apiKey: resendApiKey,
        fromEmail: 'sender@example.test',
        toEmail: emailRecipient,
        subject: emailSubject,
        text: emailText,
        idempotencyKey: emailTerminal[0]?.provider_idempotency_key,
      });
      expect(emailRequests[1]).toEqual(emailRequests[0]);
      const completedEmailJob = await waitFor(
        () => attemptQueue.getJob(emailJob.jobId),
        (job) => job !== undefined,
      );
      if (completedEmailJob === undefined) throw new Error('Email job missing');
      await waitFor(
        () => completedEmailJob.getState(),
        (state) => state === 'completed',
      );
      await waitFor(
        () => attemptQueue.getJob(retriedEmailJob.jobId),
        (job) => job !== undefined,
      );
      await completedEmailJob.remove();
      await producer.publish(emailDelivery);
      const replayedEmailJob = await waitFor(
        () => attemptQueue.getJob(emailJob.jobId),
        (job) => job !== undefined,
      );
      if (replayedEmailJob === undefined)
        throw new Error('redelivered email job missing');
      await waitFor(
        () => replayedEmailJob.getState(),
        (state) => state === 'completed',
      );
      expect(emailRequests).toHaveLength(2);

      const rotatedAdmission = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(rotatedAdmission);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: rotatedAdmission,
        },
      });
      const rotatedFirst = await attemptDelivery(
        accepted.runId,
        'email-rotated',
      );
      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: rotatedFirst.node_run_id,
          attemptId: rotatedFirst.attempt_id,
          outboxEventId: rotatedFirst.outbox_id,
        },
      });
      await waitFor(
        () =>
          workerQuery<{ status: string }>(
            `select status from app.node_attempts
             where workspace_id=$1 and id=$2`,
            [workspaceId, rotatedFirst.attempt_id],
          ),
        (rows) => rows[0]?.status === 'failed',
      );
      expect(emailRequests).toHaveLength(3);

      const rotatedRetry = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(rotatedRetry);
      const rotatedRetryJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: rotatedRetry,
        },
      });
      const persistedRotatedRetryJob = await waitFor(
        () => coordinatorQueue.getJob(rotatedRetryJob.jobId),
        (job) => job !== undefined,
      );
      if (persistedRotatedRetryJob === undefined)
        throw new Error('Rotated email retry coordinator job missing');
      await waitFor(
        () => persistedRotatedRetryJob.getState(),
        (state) => state === 'completed',
      );

      const rotatedSecret = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          type: 'resend_api_key',
          apiKey: rotatedResendApiKey,
          fromEmail: 'sender@example.test',
        }),
      );
      const sealedRotatedSecret = await encryption.seal(rotatedSecret, {
        workspaceId,
        connectionId: emailConnectionId,
        secretVersionId: rotatedEmailSecretVersionId,
      });
      rotatedSecret.fill(0);
      if (connectionDatabase === undefined)
        throw new Error('Connection database missing');
      await connectionDatabase.rotateConnectionSecret({
        workspaceId,
        actorId,
        connectionId: emailConnectionId,
        secretVersionId: rotatedEmailSecretVersionId,
        expectedCurrentSecretVersionId: emailSecretVersionId,
        expectedAuthType: 'resend_api_key',
        sealed: sealedRotatedSecret,
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      });

      const rotatedDue = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(rotatedDue);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: rotatedDue,
        },
      });
      const rotatedSecond = await attemptDelivery(
        accepted.runId,
        'email-rotated',
        2,
      );
      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: rotatedSecond.node_run_id,
          attemptId: rotatedSecond.attempt_id,
          outboxEventId: rotatedSecond.outbox_id,
        },
      });
      const rotatedTerminal = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            executor_failure_kind: string | null;
            executor_possibly_dispatched: boolean | null;
            node_status: string;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.executor_failure_kind,
                    attempt.executor_possibly_dispatched,
                    node.status node_status
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, rotatedSecond.attempt_id],
          ),
        (rows) => rows[0]?.executor_failure_kind === 'outcome_unknown',
      );
      expect(rotatedTerminal[0]).toMatchObject({
        attempt_status: 'failed',
        dispatch_marked_at: null,
        executor_failure_kind: 'outcome_unknown',
        executor_possibly_dispatched: true,
        node_status: 'running',
      });
      expect(emailRequests).toHaveLength(3);
      const rotatedTerminalContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(rotatedTerminalContinuation);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: rotatedTerminalContinuation,
        },
      });
      await waitFor(
        () =>
          workerQuery<{ status: string }>(
            `select status from app.node_runs
             where workspace_id=$1 and id=$2`,
            [workspaceId, rotatedSecond.node_run_id],
          ),
        (rows) => rows[0]?.status === 'outcome_unknown',
      );
      expect(emailRequests).toHaveLength(3);

      const durableSurface = await withOwner((client) =>
        client.query<{ surface: string }>(
          `select concat_ws(E'\n',
             (select jsonb_agg(to_jsonb(secret))::text
                from app.connection_secret_versions secret where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.connection_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(attempt))::text
                from app.node_attempts attempt where workspace_id=$1),
             (select jsonb_agg(to_jsonb(node))::text
                from app.node_runs node where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.run_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.outbox_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(receipt))::text
                from app.inbox_receipts receipt where workspace_id=$1),
             (select jsonb_agg(to_jsonb(artifact))::text
                from app.artifacts artifact where workspace_id=$1)) surface`,
          [workspaceId],
        ),
      );
      const queueSurface = JSON.stringify([delivery, replay.toJSON()]);
      expect(durableSurface.rows[0]?.surface).not.toContain(plaintextSecret);
      expect(durableSurface.rows[0]?.surface).not.toContain(slackBotToken);
      expect(durableSurface.rows[0]?.surface).not.toContain(slackMessageText);
      expect(durableSurface.rows[0]?.surface).not.toContain(resendApiKey);
      expect(durableSurface.rows[0]?.surface).not.toContain(
        rotatedResendApiKey,
      );
      expect(durableSurface.rows[0]?.surface).not.toContain(emailRecipient);
      expect(durableSurface.rows[0]?.surface).not.toContain(emailSubject);
      expect(durableSurface.rows[0]?.surface).not.toContain(emailText);
      expect(queueSurface).not.toContain(plaintextSecret);
      expect(
        JSON.stringify([slackDelivery, replayedSlackJob.toJSON()]),
      ).not.toContain(slackBotToken);
      expect(
        JSON.stringify([emailDelivery, replayedEmailJob.toJSON()]),
      ).not.toContain(resendApiKey);
      expect(JSON.stringify(telemetry)).not.toContain(plaintextSecret);
    } finally {
      await Promise.allSettled([
        attempts.close(),
        coordinator.close(),
        producer.close(),
        attemptQueue.close(),
        coordinatorQueue.close(),
        capabilities.close(),
        ...(persistedArtifactId === undefined
          ? []
          : [
              artifactVerifier
                .delete({ artifactId: persistedArtifactId, workspaceId })
                .catch(() => undefined),
            ]),
      ]);
      artifactVerifier.close();
    }
  }, 30_000);

  it.each(['http', 'slack'] as const)(
    'rejects a %s dispatch when its resolved secret rotates after the current-version assertion',
    async (target) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      if (connectionDatabase === undefined)
        throw new Error('Connection database missing');
      const apiConnectionDatabase = connectionDatabase;

      const targetConnectionId =
        target === 'http' ? connectionId : slackConnectionId;
      const targetAuthType =
        target === 'http'
          ? ('http_headers' as const)
          : ('slack_bot_token' as const);
      let rotated = false;
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        afterConnectionAssertCurrent: async (input) => {
          if (rotated || input.connectionId !== targetConnectionId) return;
          expect(input.expectedAuthType).toBe(targetAuthType);
          rotated = true;
          const rotatedSecretVersionId = randomUUID();
          const rotatedSecret = new TextEncoder().encode(
            JSON.stringify(
              target === 'http'
                ? {
                    schemaVersion: 1,
                    type: 'http_headers',
                    headers: { authorization: 'Bearer rotated-http' },
                  }
                : {
                    schemaVersion: 1,
                    type: 'slack_bot_token',
                    botToken: 'xoxb-rotated-slack',
                  },
            ),
          );
          const sealed = await encryption.seal(rotatedSecret, {
            workspaceId,
            connectionId: targetConnectionId,
            secretVersionId: rotatedSecretVersionId,
          });
          rotatedSecret.fill(0);
          await apiConnectionDatabase.rotateConnectionSecret({
            workspaceId,
            actorId,
            connectionId: targetConnectionId,
            secretVersionId: rotatedSecretVersionId,
            expectedCurrentSecretVersionId: input.secretVersionId,
            expectedAuthType: targetAuthType,
            sealed,
            idempotencyKey: randomUUID(),
            requestHash: createHash('sha256')
              .update(randomUUID())
              .digest('hex'),
          });
        },
      });
      const {
        attemptQueue,
        attempts,
        capabilities,
        coordinator,
        coordinatorQueue,
        producer,
        slackRequests,
        transportRequests,
      } = runtime;
      const accepted = await acceptRun();
      try {
        await Promise.all([
          coordinator.consumer.waitUntilReady(5_000),
          attempts.consumer.waitUntilReady(5_000),
          producer.waitUntilReady(5_000),
        ]);
        await publishAndWaitForCompletion(
          producer,
          coordinatorQueue,
          {
            name: JOB_NAME.advanceWorkflowRun,
            data: {
              schemaVersion: 1,
              workspaceId,
              runId: accepted.runId,
              outboxEventId: accepted.outboxEventId,
            },
          },
          'Initial coordinator',
        );

        const manual = await attemptDelivery(accepted.runId, 'manual');
        await publishAndWaitForCompletion(
          producer,
          attemptQueue,
          {
            name: JOB_NAME.executeNodeAttempt,
            data: {
              schemaVersion: 1 as const,
              workspaceId,
              runId: accepted.runId,
              nodeRunId: manual.node_run_id,
              attemptId: manual.attempt_id,
              outboxEventId: manual.outbox_id,
            },
          },
          'Manual node attempt',
        );

        const firstContinuation = await continuation(accepted.runId, [
          accepted.outboxEventId,
        ]);
        await publishAndWaitForCompletion(
          producer,
          coordinatorQueue,
          {
            name: JOB_NAME.advanceWorkflowRun,
            data: {
              schemaVersion: 1,
              workspaceId,
              runId: accepted.runId,
              outboxEventId: firstContinuation,
            },
          },
          'HTTP admission',
        );

        const httpAttempt = await attemptDelivery(accepted.runId, 'http');
        await publishAndWaitForCompletion(
          producer,
          attemptQueue,
          {
            name: JOB_NAME.executeNodeAttempt,
            data: {
              schemaVersion: 1 as const,
              workspaceId,
              runId: accepted.runId,
              nodeRunId: httpAttempt.node_run_id,
              attemptId: httpAttempt.attempt_id,
              outboxEventId: httpAttempt.outbox_id,
            },
          },
          'HTTP node attempt',
        );
        let targetAttempt = httpAttempt;
        const terminalContinuationExclusions = [
          accepted.outboxEventId,
          firstContinuation,
        ];
        if (target === 'slack') {
          await waitFor(
            () =>
              workerQuery<{ status: string }>(
                `select status from app.node_attempts
                 where workspace_id=$1 and id=$2`,
                [workspaceId, httpAttempt.attempt_id],
              ),
            (rows) => rows[0]?.status === 'succeeded',
          );
          const slackContinuation = await continuation(
            accepted.runId,
            terminalContinuationExclusions,
          );
          terminalContinuationExclusions.push(slackContinuation);
          await publishAndWaitForCompletion(
            producer,
            coordinatorQueue,
            {
              name: JOB_NAME.advanceWorkflowRun,
              data: {
                schemaVersion: 1,
                workspaceId,
                runId: accepted.runId,
                outboxEventId: slackContinuation,
              },
            },
            'Slack admission',
          );
          targetAttempt = await attemptDelivery(accepted.runId, 'slack');
          await publishAndWaitForCompletion(
            producer,
            attemptQueue,
            {
              name: JOB_NAME.executeNodeAttempt,
              data: {
                schemaVersion: 1 as const,
                workspaceId,
                runId: accepted.runId,
                nodeRunId: targetAttempt.node_run_id,
                attemptId: targetAttempt.attempt_id,
                outboxEventId: targetAttempt.outbox_id,
              },
            },
            'Slack node attempt',
          );
        }
        const terminal = await waitFor(
          () =>
            workerQuery<{
              attempt_status: string;
              dispatch_marked_at: Date | null;
              executor_error_kind: string | null;
              executor_failure_kind: string | null;
              executor_possibly_dispatched: boolean | null;
              node_status: string;
            }>(
              `select attempt.status attempt_status,attempt.dispatch_marked_at,
                      attempt.executor_error_kind,attempt.executor_failure_kind,
                      attempt.executor_possibly_dispatched,node.status node_status
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
              [workspaceId, targetAttempt.attempt_id],
            ),
          (rows) => rows[0]?.attempt_status === 'failed',
        );
        expect(terminal[0]).toMatchObject({
          attempt_status: 'failed',
          dispatch_marked_at: null,
          executor_error_kind: 'authentication',
          executor_failure_kind: 'failed',
          executor_possibly_dispatched: false,
          node_status: 'running',
        });
        const terminalContinuation = await continuation(accepted.runId, [
          ...terminalContinuationExclusions,
        ]);
        await publishAndWaitForCompletion(
          producer,
          coordinatorQueue,
          {
            name: JOB_NAME.advanceWorkflowRun,
            data: {
              schemaVersion: 1,
              workspaceId,
              runId: accepted.runId,
              outboxEventId: terminalContinuation,
            },
          },
          'Terminal coordinator',
        );
        const finalized = await waitFor(
          () =>
            workerQuery<{
              attempt_count: string;
              node_status: string;
              retry_decision: string | null;
              run_status: string;
            }>(
              `select attempt.retry_decision,node.status node_status,
                      run.status run_status,
                      (select count(*)::text from app.node_attempts counted
                        where counted.workspace_id=node.workspace_id
                          and counted.node_run_id=node.id) attempt_count
                 from app.node_attempts attempt
                 join app.node_runs node
                   on node.workspace_id=attempt.workspace_id
                  and node.id=attempt.node_run_id
                 join app.workflow_runs run
                   on run.workspace_id=node.workspace_id
                  and run.id=node.workflow_run_id
                where attempt.workspace_id=$1 and attempt.id=$2`,
              [workspaceId, targetAttempt.attempt_id],
            ),
          (rows) => rows[0]?.run_status === 'failed',
        );
        expect(finalized).toEqual([
          {
            attempt_count: '1',
            node_status: 'failed',
            retry_decision: 'failed',
            run_status: 'failed',
          },
        ]);
        expect(rotated).toBe(true);
        expect(transportRequests).toHaveLength(target === 'http' ? 0 : 1);
        expect(slackRequests).toHaveLength(0);
      } finally {
        await Promise.allSettled([
          attempts.close(),
          coordinator.close(),
          producer.close(),
          attemptQueue.close(),
          coordinatorQueue.close(),
          capabilities.close(),
        ]);
        runtime.artifactVerifier.close();
      }
    },
    30_000,
  );

  it('persists a transient HTTP credential-resolution failure and lets the pinned coordinator schedule exactly one retry', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    let httpResolutions = 0;
    const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
      beforeConnectionResolve: (input) => {
        if (input.expectedProviderKey === 'http') {
          httpResolutions += 1;
          if (httpResolutions === 1)
            throw new Error('transient connection-store outage');
        }
        return Promise.resolve();
      },
    });
    try {
      const scenario = await admitProviderScenario(runtime, 'http');
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Transient HTTP attempt',
      );
      const failed = await workerQuery<{
        attempt_status: string;
        continuation_count: string;
        dispatch_marked_at: Date | null;
        executor_error_kind: string | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        inbox_completed: string;
        node_status: string;
        retry_decision: string | null;
      }>(
        `select attempt.status attempt_status,attempt.dispatch_marked_at,
                attempt.executor_error_kind,attempt.executor_failure_kind,
                attempt.executor_possibly_dispatched,attempt.retry_decision,
                node.status node_status,
                (select count(*)::text from app.inbox_receipts receipt
                  where receipt.workspace_id=attempt.workspace_id
                    and receipt.message_id=$3 and receipt.completed_at is not null)
                  inbox_completed,
                (select count(*)::text from app.outbox_events outbox
                  where outbox.workspace_id=attempt.workspace_id
                    and outbox.aggregate_id=$4
                    and outbox.job_name='advance-workflow-run') continuation_count
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and attempt.id=$2`,
        [
          workspaceId,
          scenario.attempt.attempt_id,
          scenario.attempt.outbox_id,
          scenario.accepted.runId,
        ],
      );
      expect(failed[0]).toEqual({
        attempt_status: 'failed',
        continuation_count: '3',
        dispatch_marked_at: null,
        executor_error_kind: 'provider',
        executor_failure_kind: 'retry',
        executor_possibly_dispatched: false,
        inbox_completed: '1',
        node_status: 'running',
        retry_decision: 'pending',
      });
      expect(runtime.transportRequests).toHaveLength(0);

      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Transient HTTP retry decision',
      );
      const decision = await waitFor(
        () =>
          workerQuery<{
            retry_decision: string | null;
            retry_due_at: Date | null;
          }>(
            `select attempt.retry_decision,node.retry_due_at
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, scenario.attempt.attempt_id],
          ),
        (rows) => rows[0]?.retry_decision === 'retry',
      );
      expect(decision[0]?.retry_due_at).toBeInstanceOf(Date);
      const retryDueAt = decision[0]?.retry_due_at;
      if (retryDueAt === null || retryDueAt === undefined)
        throw new Error('Transient HTTP retry due time missing');
      const delayMillis = retryDueAt.getTime() - Date.now();
      if (delayMillis > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, delayMillis + 25),
        );
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Transient HTTP retry due admission',
      );
      const retry = await attemptDelivery(
        scenario.accepted.runId,
        'provider',
        2,
      );
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, retry),
        'Recovered HTTP attempt',
      );
      const recovered = await workerQuery<{
        attempt_count: string;
        attempt_numbers: number[];
        provider_keys: (string | null)[];
        statuses: string[];
      }>(
        `select count(*)::text attempt_count,
                array_agg(attempt.attempt_number order by attempt.attempt_number) attempt_numbers,
                array_agg(attempt.provider_idempotency_key order by attempt.attempt_number) provider_keys,
                array_agg(attempt.status order by attempt.attempt_number) statuses
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and node.workflow_run_id=$2
             and node.node_id='provider'`,
        [workspaceId, scenario.accepted.runId],
      );
      expect(recovered[0]).toEqual({
        attempt_count: '2',
        attempt_numbers: [1, 2],
        provider_keys: [null, null],
        statuses: ['failed', 'succeeded'],
      });
      expect(runtime.transportRequests).toHaveLength(1);
      expect(httpResolutions).toBe(2);
    } finally {
      await closeProofRuntime(runtime);
    }
  }, 30_000);

  it('keeps an internal HTTP dispatch-evidence failure non-retryable through persisted coordinator policy', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
      beforeRegistryExecute: (request) => {
        if (request.definition.key === 'http.request')
          throw new NodeExecutorFailure({
            kind: 'failed',
            errorKind: 'internal',
            possiblyDispatched: false,
          });
        return Promise.resolve();
      },
    });
    try {
      const scenario = await admitProviderScenario(runtime, 'http');
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Internal HTTP attempt',
      );
      const failed = await workerQuery<{
        dispatch_marked_at: Date | null;
        executor_error_kind: string | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        retry_decision: string | null;
      }>(
        `select dispatch_marked_at,executor_error_kind,executor_failure_kind,
                executor_possibly_dispatched,retry_decision
           from app.node_attempts where workspace_id=$1 and id=$2`,
        [workspaceId, scenario.attempt.attempt_id],
      );
      expect(failed[0]).toEqual({
        dispatch_marked_at: null,
        executor_error_kind: 'internal',
        executor_failure_kind: 'failed',
        executor_possibly_dispatched: false,
        retry_decision: 'pending',
      });
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Internal HTTP terminal decision',
      );
      const terminal = await waitFor(
        () =>
          workerQuery<{
            attempt_count: string;
            node_status: string;
            retry_decision: string;
            run_status: string;
          }>(
            `select attempt.retry_decision,node.status node_status,
                    run.status run_status,
                    (select count(*)::text from app.node_attempts candidate
                      where candidate.workspace_id=attempt.workspace_id
                        and candidate.node_run_id=attempt.node_run_id) attempt_count
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
               join app.workflow_runs run
                 on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, scenario.attempt.attempt_id],
          ),
        (rows) => rows[0]?.retry_decision === 'failed',
      );
      expect(terminal[0]).toEqual({
        attempt_count: '1',
        node_status: 'failed',
        retry_decision: 'failed',
        run_status: 'failed',
      });
      expect(runtime.transportRequests).toHaveLength(0);
    } finally {
      await closeProofRuntime(runtime);
    }
  }, 30_000);

  it.each(['canceled', 'timed_out'] as const)(
    'persists durable %s arriving after claim but before provider execution',
    async (reason) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      let controlled = false;
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        afterAttemptClaimed: async (result) => {
          if (
            result.kind !== 'claimed' ||
            result.lease.nodeId !== 'provider' ||
            controlled
          )
            return;
          controlled = true;
          if (reason === 'canceled')
            await cancelProviderScenarioRun(result.lease.runId);
          else await expireProviderScenarioRun(result.lease.runId);
        },
      });
      try {
        const scenario = await admitProviderScenario(runtime, 'http');
        await publishAndWaitForCompletion(
          runtime.producer,
          runtime.attemptQueue,
          attemptJob(scenario.accepted.runId, scenario.attempt),
          `Pre-execution ${reason} HTTP attempt`,
        );
        const completed = await workerQuery<{
          attempt_status: string;
          dispatch_marked_at: Date | null;
          inbox_completed: string;
          safe_error_code: string;
        }>(
          `select attempt.status attempt_status,attempt.dispatch_marked_at,
                  attempt.safe_error_code,
                  (select count(receipt.completed_at)::text
                     from app.inbox_receipts receipt
                    where receipt.workspace_id=attempt.workspace_id
                      and receipt.message_id=$3) inbox_completed
             from app.node_attempts attempt
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [
            workspaceId,
            scenario.attempt.attempt_id,
            scenario.attempt.outbox_id,
          ],
        );
        expect(completed).toEqual([
          {
            attempt_status: reason,
            dispatch_marked_at: null,
            inbox_completed: '1',
            safe_error_code:
              reason === 'canceled'
                ? 'execution.canceled'
                : 'execution.deadline_exceeded',
          },
        ]);
        expect(controlled).toBe(true);
        expect(runtime.transportRequests).toHaveLength(0);
        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          `Pre-execution ${reason} terminal coordinator`,
        );
        const terminal = await waitFor(
          () =>
            workerQuery<{ node_status: string; run_status: string }>(
              `select node.status node_status,run.status run_status
                 from app.node_runs node
                 join app.workflow_runs run
                   on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
                where node.workspace_id=$1 and node.workflow_run_id=$2
                  and node.node_id='provider'`,
              [workspaceId, scenario.accepted.runId],
            ),
          (rows) => rows[0]?.node_status === reason,
        );
        expect(terminal).toEqual([{ node_status: reason, run_status: reason }]);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );

  it.each(['canceled', 'timed_out'] as const)(
    'persists unsafe outcome_unknown when durable %s arrives during a heartbeat-controlled provider request',
    async (reason) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      let signalProviderStarted: (() => void) | undefined;
      const providerStarted = new Promise<void>((resolve) => {
        signalProviderStarted = resolve;
      });
      let providerCalls = 0;
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        dispatchHttp: async (request) => {
          providerCalls += 1;
          signalProviderStarted?.();
          const signal = request.signal;
          if (signal === undefined)
            throw new Error('HTTP scenario signal is missing');
          await new Promise<never>((_resolve, reject) => {
            const rejectAborted = () => {
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              );
            };
            if (signal.aborted) rejectAborted();
            else
              signal.addEventListener('abort', rejectAborted, { once: true });
          });
          throw new Error('Aborted provider request unexpectedly resumed');
        },
      });
      try {
        const scenario = await admitProviderScenario(runtime, 'http');
        const published = await runtime.producer.publish(
          attemptJob(scenario.accepted.runId, scenario.attempt),
        );
        await providerStarted;
        if (reason === 'canceled')
          await cancelProviderScenarioRun(scenario.accepted.runId);
        else await expireProviderScenarioRun(scenario.accepted.runId);
        const job = await waitFor(
          () => runtime.attemptQueue.getJob(published.jobId),
          (candidate) => candidate !== undefined,
        );
        if (job === undefined) throw new Error('Controlled HTTP job missing');
        await waitFor(
          () => job.getState(),
          (state) => state === 'completed' || state === 'failed',
        );
        expect(await job.getState()).toBe('completed');
        const completed = await workerQuery<{
          attempt_status: string;
          dispatch_marked_at: Date | null;
          inbox_completed: string;
          safe_error_code: string;
        }>(
          `select attempt.status attempt_status,attempt.dispatch_marked_at,
                  attempt.safe_error_code,
                  (select count(receipt.completed_at)::text
                     from app.inbox_receipts receipt
                    where receipt.workspace_id=attempt.workspace_id
                      and receipt.message_id=$3) inbox_completed
             from app.node_attempts attempt
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [
            workspaceId,
            scenario.attempt.attempt_id,
            scenario.attempt.outbox_id,
          ],
        );
        const completedAttempt = completed[0];
        if (completedAttempt === undefined)
          throw new Error('Completed provider attempt missing');
        expect(completedAttempt).toMatchObject({
          attempt_status: 'outcome_unknown',
          inbox_completed: '1',
          safe_error_code: 'execution.outcome_unknown',
        });
        expect(completedAttempt.dispatch_marked_at).toBeInstanceOf(Date);
        expect(providerCalls).toBe(1);
        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          `During-execution ${reason} terminal coordinator`,
        );
        const terminal = await waitFor(
          () =>
            workerQuery<{ node_status: string; run_status: string }>(
              `select node.status node_status,run.status run_status
                 from app.node_runs node
                 join app.workflow_runs run
                   on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
                where node.workspace_id=$1 and node.workflow_run_id=$2
                  and node.node_id='provider'`,
              [workspaceId, scenario.accepted.runId],
            ),
          (rows) => rows[0]?.node_status === 'outcome_unknown',
        );
        expect(terminal).toEqual([
          { node_status: 'outcome_unknown', run_status: 'outcome_unknown' },
        ]);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );

  it('keeps an email dispatch key and prior ambiguity when credential resolution fails before the retry can redispatch', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    const providerKeys: string[] = [];
    let emailResolutions = 0;
    const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
      beforeConnectionResolve: (input) => {
        if (input.expectedProviderKey === 'email') {
          emailResolutions += 1;
          if (emailResolutions === 2)
            throw new Error('connection store unavailable before redispatch');
        }
        return Promise.resolve();
      },
      sendEmailNotification: async (input) => {
        await input.beforeDispatch();
        providerKeys.push(input.idempotencyKey);
        throw new Error('provider connection reset after possible dispatch');
      },
    });
    try {
      const scenario = await admitProviderScenario(runtime, 'email');
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Ambiguous email attempt',
      );
      const first = await workerQuery<{
        dispatch_marked_at: Date | null;
        executor_error_kind: string | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        provider_dispatch_binding: string | null;
        provider_idempotency_key: string | null;
      }>(
        `select attempt.dispatch_marked_at,attempt.executor_error_kind,
                attempt.executor_failure_kind,attempt.executor_possibly_dispatched,
                attempt.provider_idempotency_key,node.provider_dispatch_binding
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, scenario.attempt.attempt_id],
      );
      const firstAttempt = first[0];
      if (firstAttempt === undefined)
        throw new Error('Ambiguous email attempt missing');
      expect(firstAttempt).toMatchObject({
        executor_error_kind: 'network',
        executor_failure_kind: 'retry',
        executor_possibly_dispatched: true,
      });
      expect(firstAttempt.dispatch_marked_at).toBeInstanceOf(Date);
      expect(firstAttempt.provider_dispatch_binding).toMatch(
        /^email:v1:sha256:[0-9a-f]{64}$/u,
      );
      expect(firstAttempt.provider_idempotency_key).toMatch(
        /^v1\.[0-9a-f]{64}$/u,
      );
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Ambiguous email retry decision',
      );
      const retryDue = await waitFor(
        () =>
          workerQuery<{ retry_due_at: Date | null }>(
            `select retry_due_at from app.node_runs
               where workspace_id=$1 and workflow_run_id=$2 and node_id='provider'`,
            [workspaceId, scenario.accepted.runId],
          ),
        (rows) => rows[0]?.retry_due_at instanceof Date,
      );
      const retryDueAt = retryDue[0]?.retry_due_at;
      if (retryDueAt === null || retryDueAt === undefined)
        throw new Error('Ambiguous email retry due time missing');
      const delayMillis = retryDueAt.getTime() - Date.now();
      if (delayMillis > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, delayMillis + 25),
        );
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Ambiguous email retry due admission',
      );
      const retry = await attemptDelivery(
        scenario.accepted.runId,
        'provider',
        2,
      );
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, retry),
        'Pre-redispatch email resolution failure',
      );
      const attempts = await workerQuery<{
        attempt_number: number;
        dispatch_marked_at: Date | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        provider_dispatch_binding: string | null;
        provider_idempotency_key: string | null;
      }>(
        `select attempt.attempt_number,attempt.dispatch_marked_at,
                attempt.executor_failure_kind,attempt.executor_possibly_dispatched,
                attempt.provider_idempotency_key,node.provider_dispatch_binding
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and node.workflow_run_id=$2
             and node.node_id='provider'
           order by attempt.attempt_number`,
        [workspaceId, scenario.accepted.runId],
      );
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({
        attempt_number: 2,
        dispatch_marked_at: null,
        executor_failure_kind: 'outcome_unknown',
        executor_possibly_dispatched: true,
        provider_dispatch_binding: attempts[0]?.provider_dispatch_binding,
        provider_idempotency_key: attempts[0]?.provider_idempotency_key,
      });
      expect(providerKeys).toEqual([attempts[0]?.provider_idempotency_key]);
      expect(emailResolutions).toBe(2);
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Ambiguous email terminal decision',
      );
      await expect(
        workerQuery<{ attempt_count: string; node_status: string }>(
          `select node.status node_status,
                  (select count(*)::text from app.node_attempts attempt
                    where attempt.workspace_id=node.workspace_id
                      and attempt.node_run_id=node.id) attempt_count
             from app.node_runs node
             where node.workspace_id=$1 and node.workflow_run_id=$2
               and node.node_id='provider'`,
          [workspaceId, scenario.accepted.runId],
        ),
      ).resolves.toEqual([
        { attempt_count: '2', node_status: 'outcome_unknown' },
      ]);
    } finally {
      await closeProofRuntime(runtime);
    }
  }, 30_000);

  it.each([
    ['canceled', 'early'],
    ['timed_out', 'early'],
    ['canceled', 'heartbeat'],
    ['timed_out', 'heartbeat'],
  ] as const)(
    'preserves prior keyed email ambiguity when %s is observed on the retry %s path before redispatch',
    async (reason, entryPath) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      let emailResolutions = 0;
      let providerCalls = 0;
      const providerKeys: string[] = [];
      let signalRetryResolution: (() => void) | undefined;
      const retryResolution = new Promise<void>((resolve) => {
        signalRetryResolution = resolve;
      });
      let releaseRetryResolution: (() => void) | undefined;
      const retryResolutionRelease = new Promise<void>((resolve) => {
        releaseRetryResolution = resolve;
      });
      let signalDurableAbort: (() => void) | undefined;
      const durableAbort = new Promise<void>((resolve) => {
        signalDurableAbort = resolve;
      });
      const requestControl = (runId: string) =>
        reason === 'canceled'
          ? cancelProviderScenarioRun(runId)
          : expireProviderScenarioRun(runId);
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        afterAttemptClaimed: async (result) => {
          if (
            entryPath === 'early' &&
            result.kind === 'claimed' &&
            result.lease.nodeId === 'provider' &&
            result.lease.attemptNumber === 2
          )
            await requestControl(result.lease.runId);
        },
        afterHeartbeat: (result) => {
          if (entryPath === 'heartbeat' && result.abortRequested)
            signalDurableAbort?.();
          return Promise.resolve();
        },
        beforeConnectionResolve: async (input) => {
          if (input.expectedProviderKey !== 'email') return;
          emailResolutions += 1;
          if (entryPath === 'heartbeat' && emailResolutions === 2) {
            signalRetryResolution?.();
            await retryResolutionRelease;
          }
        },
        heartbeatIntervalMillis: 50,
        sendEmailNotification: async (input) => {
          await input.beforeDispatch();
          providerCalls += 1;
          providerKeys.push(input.idempotencyKey);
          throw new Error('provider connection reset after possible dispatch');
        },
      });
      try {
        const scenario = await prepareAmbiguousEmailRetry(runtime);
        if (entryPath === 'early') {
          await publishAndWaitForCompletion(
            runtime.producer,
            runtime.attemptQueue,
            attemptJob(scenario.accepted.runId, scenario.retry),
            `Early ${reason} email retry`,
          );
        } else {
          const published = await runtime.producer.publish(
            attemptJob(scenario.accepted.runId, scenario.retry),
          );
          await retryResolution;
          await requestControl(scenario.accepted.runId);
          await durableAbort;
          releaseRetryResolution?.();
          const job = await waitFor(
            () => runtime.attemptQueue.getJob(published.jobId),
            (candidate) => candidate !== undefined,
          );
          if (job === undefined)
            throw new Error('Blocked email retry is missing');
          await waitFor(
            () => job.getState(),
            (state) => state === 'completed' || state === 'failed',
          );
          expect(await job.getState()).toBe('completed');
        }

        const attempts = await workerQuery<{
          attempt_number: number;
          dispatch_marked_at: Date | null;
          executor_failure_kind: string | null;
          executor_possibly_dispatched: boolean | null;
          provider_dispatch_binding: string | null;
          provider_idempotency_key: string | null;
          safe_error_code: string | null;
          status: string;
        }>(
          `select attempt.attempt_number,attempt.status,
                  attempt.dispatch_marked_at,attempt.safe_error_code,
                  attempt.executor_failure_kind,
                  attempt.executor_possibly_dispatched,
                  attempt.provider_idempotency_key,
                  node.provider_dispatch_binding
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id
              and node.id=attempt.node_run_id
            where attempt.workspace_id=$1 and node.workflow_run_id=$2
              and node.node_id='provider'
            order by attempt.attempt_number`,
          [workspaceId, scenario.accepted.runId],
        );
        expect(attempts).toHaveLength(2);
        expect(attempts[0]?.dispatch_marked_at).toBeInstanceOf(Date);
        expect(attempts[0]?.provider_idempotency_key).toMatch(
          /^v1\.[0-9a-f]{64}$/u,
        );
        expect(attempts[0]).toMatchObject({
          attempt_number: 1,
          executor_failure_kind: 'retry',
          executor_possibly_dispatched: true,
        });
        expect(attempts[1]).toMatchObject({
          attempt_number: 2,
          dispatch_marked_at: null,
          executor_failure_kind: null,
          executor_possibly_dispatched: null,
          provider_dispatch_binding: attempts[0]?.provider_dispatch_binding,
          provider_idempotency_key: attempts[0]?.provider_idempotency_key,
          safe_error_code: 'execution.outcome_unknown',
          status: 'outcome_unknown',
        });
        expect(providerCalls).toBe(1);
        expect(providerKeys).toEqual([attempts[0]?.provider_idempotency_key]);
        expect(emailResolutions).toBe(entryPath === 'early' ? 1 : 2);
        await expect(
          workerQuery<{ completed: string }>(
            `select count(completed_at)::text completed
               from app.inbox_receipts
              where workspace_id=$1 and message_id=$2`,
            [workspaceId, scenario.retry.outbox_id],
          ),
        ).resolves.toEqual([{ completed: '1' }]);

        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          `${entryPath} ${reason} email terminal decision`,
        );
        await expect(
          workerQuery<{ node_status: string; run_status: string }>(
            `select node.status node_status,run.status run_status
               from app.node_runs node
               join app.workflow_runs run
                 on run.workspace_id=node.workspace_id
                and run.id=node.workflow_run_id
              where node.workspace_id=$1 and node.workflow_run_id=$2
                and node.node_id='provider'`,
            [workspaceId, scenario.accepted.runId],
          ),
        ).resolves.toEqual([
          { node_status: 'outcome_unknown', run_status: 'outcome_unknown' },
        ]);
      } finally {
        releaseRetryResolution?.();
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );

  it('recovers a keyed provider attempt after heartbeat ownership is lost without accepting stale completion or exact redelivery', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    let oldLease: NodeAttemptLease | undefined;
    let signalProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    const providerKeys: string[] = [];
    let providerInFlight = false;
    const firstRuntime = await createHttpNodeAttemptProofRuntime(encryption, {
      afterAttemptClaimed: (result) => {
        if (result.kind === 'claimed' && result.lease.nodeId === 'provider')
          oldLease = result.lease;
        return Promise.resolve();
      },
      beforeHeartbeat: (input) => {
        if (input.lease.nodeId === 'provider' && providerInFlight)
          throw new Error('heartbeat ownership lost');
        return Promise.resolve();
      },
      heartbeatIntervalMillis: 50,
      leaseDurationSeconds: 1,
      sendEmailNotification: async (input) => {
        await input.beforeDispatch();
        providerKeys.push(input.idempotencyKey);
        providerInFlight = true;
        signalProviderStarted?.();
        const signal = input.signal;
        if (signal === undefined)
          throw new Error('Email scenario signal is missing');
        await new Promise<never>((_resolve, reject) => {
          const rejectAborted = () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          };
          if (signal.aborted) rejectAborted();
          else signal.addEventListener('abort', rejectAborted, { once: true });
        });
        throw new Error('Aborted email request unexpectedly resumed');
      },
    });
    const scenario = await admitProviderScenario(firstRuntime, 'email');
    const firstPublished = await firstRuntime.producer.publish(
      attemptJob(scenario.accepted.runId, scenario.attempt),
    );
    try {
      await providerStarted;
      const failedJob = await waitFor(
        () => firstRuntime.attemptQueue.getJob(firstPublished.jobId),
        (candidate) => candidate !== undefined,
      );
      if (failedJob === undefined)
        throw new Error('Heartbeat-loss email job missing');
      await waitFor(
        () => failedJob.getState(),
        (state) => state === 'failed',
      );
      const abandoned = await workerQuery<{
        dispatch_marked_at: Date | null;
        fence_token: string;
        inbox_completed: string;
        lease_expires_at: Date;
        provider_idempotency_key: string;
        status: string;
      }>(
        `select attempt.status,attempt.fence_token::text,
                attempt.lease_expires_at,attempt.dispatch_marked_at,
                attempt.provider_idempotency_key,
                (select count(receipt.completed_at)::text
                   from app.inbox_receipts receipt
                  where receipt.workspace_id=attempt.workspace_id
                    and receipt.message_id=$3) inbox_completed
           from app.node_attempts attempt
          where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, scenario.attempt.attempt_id, scenario.attempt.outbox_id],
      );
      const abandonedAttempt = abandoned[0];
      if (abandonedAttempt === undefined)
        throw new Error('Abandoned provider attempt missing');
      expect(abandonedAttempt).toMatchObject({
        fence_token: '1',
        inbox_completed: '0',
        status: 'running',
      });
      expect(abandonedAttempt.dispatch_marked_at).toBeInstanceOf(Date);
      expect(abandonedAttempt.lease_expires_at).toBeInstanceOf(Date);
      expect(abandonedAttempt.provider_idempotency_key).toMatch(
        /^v1\.[0-9a-f]{64}$/u,
      );
      expect(providerKeys).toEqual([abandonedAttempt.provider_idempotency_key]);
      const lease = oldLease;
      if (lease === undefined) throw new Error('Heartbeat-loss lease missing');

      await closeProofRuntime(firstRuntime);
      const leaseDelay =
        abandonedAttempt.lease_expires_at.getTime() - Date.now();
      if (leaseDelay > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, leaseDelay + 25),
        );
      const reclaimed = await reclaimProviderScenarioAttempt({
        attemptId: scenario.attempt.attempt_id,
        expectedFence: 1,
      });
      expect(reclaimed).toMatchObject({
        command_outcome: 'reclaimed',
        result: {
          fenceToken: 2,
          outcome: 'reclaimed',
          schemaVersion: 1,
        },
      });
      expect(reclaimed.result.outboxEventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );

      const staleStore = createNodeAttemptRunStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 1,
        }),
      );
      try {
        await expect(
          staleStore.complete({
            lease,
            outcome: {
              status: 'succeeded',
              output: { emailId: '3e6b2d7e-80fd-4b80-852c-735169874e1c' },
            },
            signal: new AbortController().signal,
          }),
        ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);
      } finally {
        await staleStore.close();
      }

      const secondRuntime = await createHttpNodeAttemptProofRuntime(
        encryption,
        {
          sendEmailNotification: async (input) => {
            await input.beforeDispatch();
            providerKeys.push(input.idempotencyKey);
            return {
              kind: 'succeeded',
              emailId: '3e6b2d7e-80fd-4b80-852c-735169874e1c',
            };
          },
        },
      );
      try {
        await Promise.all([
          secondRuntime.attempts.consumer.waitUntilReady(5_000),
          secondRuntime.producer.waitUntilReady(5_000),
        ]);
        const recoveryDelivery = {
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1 as const,
            workspaceId,
            runId: scenario.accepted.runId,
            nodeRunId: scenario.attempt.node_run_id,
            attemptId: scenario.attempt.attempt_id,
            outboxEventId: reclaimed.result.outboxEventId,
          },
        };
        const recoveredJob = await publishAndWaitForCompletion(
          secondRuntime.producer,
          secondRuntime.attemptQueue,
          recoveryDelivery,
          'Reclaimed email attempt',
        );
        const recovered = await workerQuery<{
          completed_receipts: string;
          continuation_count: string;
          fence_token: string;
          node_status: string;
          provider_idempotency_key: string;
          status: string;
        }>(
          `select attempt.status,attempt.fence_token::text,
                  attempt.provider_idempotency_key,node.status node_status,
                  (select count(receipt.completed_at)::text
                     from app.inbox_receipts receipt
                    where receipt.workspace_id=attempt.workspace_id
                      and receipt.message_id in ($3,$4)) completed_receipts,
                  (select count(*)::text from app.outbox_events outbox
                    where outbox.workspace_id=attempt.workspace_id
                      and outbox.aggregate_id=$5
                      and outbox.job_name='advance-workflow-run') continuation_count
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [
            workspaceId,
            scenario.attempt.attempt_id,
            scenario.attempt.outbox_id,
            reclaimed.result.outboxEventId,
            scenario.accepted.runId,
          ],
        );
        expect(recovered).toEqual([
          {
            completed_receipts: '1',
            continuation_count: '3',
            fence_token: '3',
            node_status: 'succeeded',
            provider_idempotency_key: abandonedAttempt.provider_idempotency_key,
            status: 'succeeded',
          },
        ]);
        expect(providerKeys).toEqual([
          abandonedAttempt.provider_idempotency_key,
          abandonedAttempt.provider_idempotency_key,
        ]);
        const beforeDuplicate = recovered[0];
        await recoveredJob.remove();
        await publishAndWaitForCompletion(
          secondRuntime.producer,
          secondRuntime.attemptQueue,
          recoveryDelivery,
          'Exact reclaimed email redelivery',
        );
        await expect(
          workerQuery<{
            completed_receipts: string;
            continuation_count: string;
            fence_token: string;
            node_status: string;
            provider_idempotency_key: string;
            status: string;
          }>(
            `select attempt.status,attempt.fence_token::text,
                    attempt.provider_idempotency_key,node.status node_status,
                    (select count(receipt.completed_at)::text
                       from app.inbox_receipts receipt
                      where receipt.workspace_id=attempt.workspace_id
                        and receipt.message_id in ($3,$4)) completed_receipts,
                    (select count(*)::text from app.outbox_events outbox
                      where outbox.workspace_id=attempt.workspace_id
                        and outbox.aggregate_id=$5
                        and outbox.job_name='advance-workflow-run') continuation_count
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
              where attempt.workspace_id=$1 and attempt.id=$2`,
            [
              workspaceId,
              scenario.attempt.attempt_id,
              scenario.attempt.outbox_id,
              reclaimed.result.outboxEventId,
              scenario.accepted.runId,
            ],
          ),
        ).resolves.toEqual([beforeDuplicate]);
        expect(providerKeys).toHaveLength(2);
      } finally {
        await closeProofRuntime(secondRuntime);
      }
    } finally {
      await closeProofRuntime(firstRuntime);
    }
  }, 30_000);

  it('keeps a logical retry key but derives a new provider identity for an operator replay without rewriting source history', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    const runtime = await createHttpNodeAttemptProofRuntime(encryption);
    const operator = createOperatorCommandDatabase(
      parseOperatorDatabaseConfig({
        ...process.env,
        DATABASE_OPERATOR_URL: databaseUrl(operatorUrl),
      }),
    );
    const replayStore = createDatabaseOperatorRunReplayStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 1,
      }),
      'email_activation',
    );
    try {
      const source = await admitProviderScenario(runtime, 'email');
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(source.accepted.runId, source.attempt),
        'Source email attempt',
      );
      await withOwner((client) =>
        client.query(
          `update app.workflow_runs
              set status='succeeded',completed_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            where workspace_id=$1 and id=$2`,
          [workspaceId, source.accepted.runId],
        ),
      );
      const sourceRows = await workerQuery<{
        provider_idempotency_key: string;
        run_status: string;
      }>(
        `select attempt.provider_idempotency_key,run.status run_status
           from app.node_attempts attempt
           join app.node_runs node on node.workspace_id=attempt.workspace_id
             and node.id=attempt.node_run_id
           join app.workflow_runs run on run.workspace_id=node.workspace_id
             and run.id=node.workflow_run_id
          where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, source.attempt.attempt_id],
      );
      const sourceRow = sourceRows[0];
      if (sourceRow === undefined)
        throw new Error('Source provider attempt missing');
      expect(sourceRow.run_status).toBe('succeeded');
      expect(sourceRow.provider_idempotency_key).toMatch(/^v1\.[0-9a-f]{64}$/u);

      const commandId = randomUUID();
      const requested = await operator.replayRun({
        actorRef: 'node-attempt-proof',
        commandId,
        dryRun: false,
        reason: 'prove replay provider identity isolation',
        runInput: {},
        sourceRunId: source.accepted.runId,
        workflowVersionId: source.accepted.workflowVersionId,
        workspaceId,
      });
      const replayOutboxId = requested.result.outboxEventId;
      if (typeof replayOutboxId !== 'string')
        throw new Error('Replay outbox identity missing');
      const replayed = await replayStore.replay({
        commandId,
        delivery: {
          outboxEventId: replayOutboxId,
          payloadChecksum: canonicalOutboxPayloadChecksum({
            commandId,
            outboxEventId: replayOutboxId,
            schemaVersion: 1,
            workspaceId,
          }),
        },
        workspaceId,
      });
      if (replayed.kind !== 'processed' || replayed.runId === undefined)
        throw new Error('Replay run was not created');
      expect(replayed.runId).not.toBe(source.accepted.runId);

      const replayInitialOutbox = await continuation(replayed.runId, []);
      const coordinatorOutboxes = [replayInitialOutbox];
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.coordinatorQueue,
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: replayed.runId,
            outboxEventId: replayInitialOutbox,
          },
        },
        'Replay initial coordinator',
      );
      const replayManual = await attemptDelivery(replayed.runId, 'manual');
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(replayed.runId, replayManual),
        'Replay manual attempt',
      );
      await advanceScenario(
        runtime,
        replayed.runId,
        coordinatorOutboxes,
        'Replay provider admission',
      );
      const replayProvider = await attemptDelivery(replayed.runId, 'provider');
      const identities = await workerQuery<{
        id: string;
        provider_idempotency_key: string;
      }>(
        `select attempt.id,attempt.provider_idempotency_key
           from app.node_attempts attempt
          where attempt.workspace_id=$1 and attempt.id=any($2::uuid[])
          order by attempt.id`,
        [workspaceId, [source.attempt.attempt_id, replayProvider.attempt_id]],
      );
      const byId = new Map(
        identities.map((row) => [row.id, row.provider_idempotency_key]),
      );
      expect(byId.get(source.attempt.attempt_id)).toBe(
        sourceRows[0]?.provider_idempotency_key,
      );
      expect(byId.get(replayProvider.attempt_id)).toMatch(
        /^v1\.[0-9a-f]{64}$/u,
      );
      expect(byId.get(replayProvider.attempt_id)).not.toBe(
        sourceRows[0]?.provider_idempotency_key,
      );
    } finally {
      await Promise.allSettled([operator.close(), replayStore.close()]);
      await closeProofRuntime(runtime);
    }
  }, 30_000);
});
