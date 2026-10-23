import { createHash, randomUUID } from 'node:crypto';
import { JOB_NAME } from '@pertexo/queue';

import { expect, it } from 'vitest';

import { createHttpNodeAttemptProofRuntime } from '../../../support/attempts/http-node-attempt.runtime.js';

import {
  acceptRun,
  actorId,
  attemptDelivery,
  connectionDatabase,
  connectionId,
  continuation,
  emailConnectionId,
  emailRecipient,
  emailSecretVersionId,
  emailSubject,
  emailText,
  plaintextSecret,
  resendApiKey,
  responseBytes,
  rotatedEmailSecretVersionId,
  rotatedResendApiKey,
  slackBotToken,
  slackConnectionId,
  slackMessageText,
  waitFor,
  withOwner,
  workerQuery,
  workspaceId,
} from '../../../support/attempts/http-node-attempt.js';
import { runWithCleanup } from '../../../support/infrastructure/test-operation.js';
import {
  fixtureEncryption,
  readAttemptRedeliverySnapshot,
  readArtifactIds,
} from '../fixture.js';

export function registerArtifactAttemptPersistence(): void {
  it('commits artifact, attempt truth, audit, bounded telemetry, and inert exact redelivery without leaking credentials', async () => {
    const scenario = await createArtifactScenario();
    await runWithCleanup(
      async () => {
        await captureArtifactScenarioBaselines(scenario);
        const http = await executeArtifactHttpAttempt(scenario);
        const audit = await assertArtifactHttpEvidence(scenario, http);
        const replay = await proveArtifactHttpRedelivery(scenario, {
          ...http,
          audit,
        });
        const slack = await proveArtifactSlackRedelivery(scenario);
        const email = await proveArtifactEmailRetry(scenario);
        await proveArtifactRotatedCredentialFence(scenario);
        await assertArtifactScenarioPrivacy(scenario, {
          delivery: http.delivery,
          replay,
          ...slack,
          ...email,
        });
      },
      () => closeArtifactScenario(scenario),
      'HTTP artifact scenario',
    );
  }, 30_000);
}

async function createArtifactScenario() {
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
  } = await createHttpNodeAttemptProofRuntime(encryption, {
    emailResponseScript: [
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
      {
        kind: 'succeeded',
        emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
      },
      { kind: 'invalid_response' },
    ],
  });
  const coordinatorOutboxes = [accepted.outboxEventId];
  const retained: {
    persistedArtifactId: string | undefined;
    artifactBaseline: Set<string> | undefined;
    credentialAuditBaseline: number;
    slackAuditBaseline: number;
  } = {
    persistedArtifactId: undefined,
    artifactBaseline: undefined,
    credentialAuditBaseline: 0,
    slackAuditBaseline: 0,
  };

  return {
    encryption,
    accepted,
    coordinatorOutboxes,
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
    retained,
  };
}
type ArtifactScenario = Awaited<ReturnType<typeof createArtifactScenario>>;
type HttpEvidence = Awaited<ReturnType<typeof executeArtifactHttpAttempt>>;
type PrivateEvidence = Pick<HttpEvidence, 'delivery'> & {
  replay: Awaited<ReturnType<typeof proveArtifactHttpRedelivery>>;
} & Awaited<ReturnType<typeof proveArtifactSlackRedelivery>> &
  Awaited<ReturnType<typeof proveArtifactEmailRetry>>;
async function captureArtifactScenarioBaselines(scenario: ArtifactScenario) {
  const { retained } = scenario;
  retained.artifactBaseline = await readArtifactIds();
  retained.credentialAuditBaseline = Number(
    (
      await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
                where workspace_id=$1 and connection_id=$2
                  and event_type='connection.credential_accessed'
                  and actor_kind='worker'`,
          [workspaceId, connectionId],
        ),
      )
    ).rows[0]?.count ?? '0',
  );
  retained.slackAuditBaseline = Number(
    (
      await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
                where workspace_id=$1 and connection_id=$2
                  and event_type='connection.credential_accessed'
                  and actor_kind='worker'`,
          [workspaceId, slackConnectionId],
        ),
      )
    ).rows[0]?.count ?? '0',
  );
}

async function executeArtifactHttpAttempt(scenario: ArtifactScenario) {
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

async function assertArtifactHttpEvidence(
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

async function proveArtifactHttpRedelivery(
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

async function proveArtifactSlackRedelivery(scenario: ArtifactScenario) {
  const {
    accepted,
    coordinatorOutboxes,
    attemptQueue,
    producer,
    slackRequests,
    retained,
  } = scenario;
  const slackContinuation = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(slackContinuation);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: slackContinuation,
    },
  });
  const slack = await attemptDelivery(accepted.runId, 'slack');
  const slackDelivery = {
    name: JOB_NAME.executeNodeAttempt,
    data: {
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
  expect(slackAudit.rows[0]?.count).toBe(
    String(retained.slackAuditBaseline + 1),
  );
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

  return { slackDelivery, replayedSlackJob };
}

async function proveArtifactEmailRetry(scenario: ArtifactScenario) {
  const {
    accepted,
    coordinatorOutboxes,
    attemptQueue,
    coordinatorQueue,
    emailRequests,
    producer,
  } = scenario;
  const emailContinuation = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(emailContinuation);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: emailContinuation,
    },
  });
  const email = await attemptDelivery(accepted.runId, 'email');
  const emailDelivery = {
    name: JOB_NAME.executeNodeAttempt,
    data: {
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
    `email:sha256:${createHash('sha256')
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

  return { emailDelivery, replayedEmailJob };
}

async function proveArtifactRotatedCredentialFence(scenario: ArtifactScenario) {
  const {
    encryption,
    accepted,
    coordinatorOutboxes,
    coordinatorQueue,
    emailRequests,
    producer,
  } = scenario;
  const rotatedAdmission = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(rotatedAdmission);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: rotatedAdmission,
    },
  });
  const rotatedFirst = await attemptDelivery(accepted.runId, 'email-rotated');
  await producer.publish({
    name: JOB_NAME.executeNodeAttempt,
    data: {
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

  const rotatedRetry = await continuation(accepted.runId, coordinatorOutboxes);
  coordinatorOutboxes.push(rotatedRetry);
  const rotatedRetryJob = await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
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

  const rotatedDue = await continuation(accepted.runId, coordinatorOutboxes);
  coordinatorOutboxes.push(rotatedDue);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
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
}

async function assertArtifactScenarioPrivacy(
  scenario: ArtifactScenario,
  evidence: PrivateEvidence,
) {
  const { telemetry } = scenario;
  const {
    delivery,
    replay,
    slackDelivery,
    replayedSlackJob,
    emailDelivery,
    replayedEmailJob,
  } = evidence;
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
  expect(durableSurface.rows[0]?.surface).not.toContain(rotatedResendApiKey);
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
}

async function closeArtifactScenario(scenario: ArtifactScenario) {
  const {
    artifactVerifier,
    attemptQueue,
    attempts,
    capabilities,
    coordinator,
    coordinatorQueue,
    producer,
    retained,
  } = scenario;
  const errors: unknown[] = [];
  const attempt = async (operation: () => unknown): Promise<void> => {
    await Promise.resolve()
      .then(operation)
      .catch((error: unknown) => errors.push(error));
  };
  await attempt(() => attempts.close());
  await attempt(() => coordinator.close());
  await attempt(() => producer.close());
  await attempt(() => attemptQueue.close());
  await attempt(() => coordinatorQueue.close());
  const baseline = retained.artifactBaseline;
  if (baseline !== undefined)
    await attempt(async () => {
      const current = await readArtifactIds();
      for (const artifactId of current)
        if (!baseline.has(artifactId))
          await artifactVerifier.delete({ artifactId, workspaceId });
    });
  else if (retained.persistedArtifactId !== undefined) {
    const ownedArtifactId = retained.persistedArtifactId;
    await attempt(() =>
      artifactVerifier.delete({
        artifactId: ownedArtifactId,
        workspaceId,
      }),
    );
  }
  await attempt(() => capabilities.close());
  await attempt(() => {
    artifactVerifier.close();
  });
  if (errors.length > 0)
    throw new AggregateError(errors, 'HTTP artifact scenario cleanup failed');
}
