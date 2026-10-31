import { createHash } from 'node:crypto';
import { JOB_NAME } from '@pertexo/queue';
import { expect } from 'vitest';

import {
  attemptDelivery,
  connectionId,
  continuation,
  plaintextSecret,
  responseBytes,
  waitFor,
  withOwner,
  workerQuery,
  workspaceId,
} from '../../../../support/attempts/http-node-attempt.js';

import { readAttemptRedeliverySnapshot } from '../../fixture.js';
import type { ArtifactScenario } from './context.js';

export type HttpEvidence = Awaited<
  ReturnType<typeof executeArtifactHttpAttempt>
>;

export async function executeArtifactHttpAttempt(scenario: ArtifactScenario) {
  const {
    accepted,
    coordinatorOutboxes,
    artifactVerifier,
    attempts,
    coordinator,
    coordinatorQueue,
    producer,
    transportRequests,
    retained,
  } = scenario;
  await Promise.all([
    coordinator.consumer.waitUntilReady(5_000),
    attempts.consumer.waitUntilReady(5_000),
    producer.waitUntilReady(5_000),
  ]);
  const initialCoordinatorJob = await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
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
      workspaceId,
      runId: accepted.runId,
      outboxEventId: firstContinuation,
    },
  });
  const admissionJob = await waitFor(
    () => coordinatorQueue.getJob(httpAdmission.jobId),
    (job) => job !== undefined,
  );
  if (admissionJob === undefined) throw new Error('HTTP admission job missing');
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
    // A GET only reads: the attempt repeats safely, the node keeps its pin.
    attempt_side_effect_class: 'safe',
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
  retained.persistedArtifactId = artifactId;
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

  return { http, artifactId, expectedArtifact, delivery, published };
}

export async function assertArtifactHttpEvidence(
  scenario: ArtifactScenario,
  evidence: HttpEvidence,
) {
  const { accepted, telemetry, retained } = scenario;
  const { http, artifactId, expectedArtifact } = evidence;
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
  expect(audit.rows[0]?.count).toBe(
    String(retained.credentialAuditBaseline + 1),
  );
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

  return audit;
}

export async function proveArtifactHttpRedelivery(
  scenario: ArtifactScenario,
  evidence: HttpEvidence & {
    audit: Awaited<ReturnType<typeof assertArtifactHttpEvidence>>;
  },
) {
  const { accepted, attemptQueue, producer, telemetry, transportRequests } =
    scenario;
  const { http, artifactId, delivery, published, audit } = evidence;
  const completedJob = await waitFor(
    () => attemptQueue.getJob(published.jobId),
    (job) => job !== undefined,
  );
  if (completedJob === undefined) throw new Error('HTTP job missing');
  await waitFor(
    () => completedJob.getState(),
    (state) => state === 'completed',
  );
  const beforeRedelivery = await readAttemptRedeliverySnapshot({
    artifactId,
    attemptId: http.attempt_id,
    messageId: http.outbox_id,
    runId: accepted.runId,
  });
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
    readAttemptRedeliverySnapshot({
      artifactId,
      attemptId: http.attempt_id,
      messageId: http.outbox_id,
      runId: accepted.runId,
    }),
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

  return replay;
}
