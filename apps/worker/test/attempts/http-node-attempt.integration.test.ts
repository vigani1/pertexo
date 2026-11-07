import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  installHttpNodeAttemptFixture,
  actorId,
  connectionStore,
  cancelProviderScenarioRun,
  plaintextSecret,
  resetProviderScenarioIsolation,
  withOwner,
  workerQuery,
  workspaceId,
  acceptRun,
  attemptDelivery,
  connectionId,
  continuation,
  slackConnectionId,
  waitFor,
  expireProviderScenarioRun,
  databaseUrl,
  reclaimProviderScenarioAttempt,
  workerUrl,
  operatorUrl,
} from '../support/attempts/http-node-attempt.js';
import {
  describeIntegration,
  prepareHttpIntegrationTestTsFixture,
  resetHttpIntegrationTestTsFixture,
  fixtureEncryption,
  publishAndWaitForCompletion,
  attemptJob,
  admitProviderScenario,
  advanceScenario,
  closeProofRuntime,
  createOwnedBarrier,
  prepareAmbiguousEmailRetry,
  readSourceRunHistory,
} from './http/http-node-attempt.fixture.js';
import { createHash, randomUUID } from 'node:crypto';
import { createHttpNodeAttemptProofRuntime } from '../support/attempts/http-node-attempt.runtime.js';
import { runWithCleanup } from '../support/infrastructure/test-operation.js';
import {
  createArtifactScenario,
  captureArtifactScenarioBaselines,
  closeArtifactScenario,
} from './http/execution/artifact-scenario/context.js';
import {
  executeArtifactHttpAttempt,
  assertArtifactHttpEvidence,
  proveArtifactHttpRedelivery,
} from './http/execution/artifact-scenario/artifact-http.fixture.js';
import { proveArtifactSlackRedelivery } from './http/execution/artifact-scenario/slack.js';
import { proveArtifactEmailRetry } from './http/execution/artifact-scenario/email.js';
import { proveArtifactRotatedCredentialFence } from './http/execution/artifact-scenario/rotation.js';
import { assertArtifactScenarioPrivacy } from './http/execution/artifact-scenario/privacy.js';
import { JOB_NAME } from '@pertexo/queue/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import {
  createNodeAttemptRunStore,
  type NodeAttemptLease,
} from '@pertexo/core/attempts';
import { NodeAttemptReconciliationRequiredError } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { canonicalOutboxPayloadChecksum } from '@pertexo/core/outbox';
import { createOperatorCommandStore } from '@pertexo/core/operator';
import { parseOperatorDatabaseConfig } from '@pertexo/database/platform';
import { createDatabaseOperatorRunReplayStore } from '../../src/operator/run-replay.js';

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);
describeIntegration('active HTTP node attempt', () => {
  it.each(['slack', 'email'] as const)(
    'persists the %s provider delay and schedules its retry no earlier',
    async (provider) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('Provider fixture encryption is missing');
      const hint = 7_000;
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        sendSlackMessage: () =>
          Promise.resolve({ kind: 'rate_limited', retryAfterMillis: hint }),
        sendEmailNotification: () =>
          Promise.resolve({ kind: 'rate_limited', retryAfterMillis: hint }),
      });
      let scenario:
        Awaited<ReturnType<typeof admitProviderScenario>> | undefined;
      await runWithCleanup(
        async () => {
          scenario = await admitProviderScenario(runtime, provider);
          await publishAndWaitForCompletion(
            runtime.producer,
            runtime.attemptQueue,
            attemptJob(scenario.accepted.runId, scenario.attempt),
            'Rate-limited provider attempt',
          );
          const stored = await workerQuery<{
            executor_retry_after_millis: number | null;
            completed_at: Date;
          }>(
            'select executor_retry_after_millis,completed_at from app.node_attempts where workspace_id=$1 and id=$2',
            [workspaceId, scenario.attempt.attempt_id],
          );
          expect(stored[0]?.executor_retry_after_millis).toBe(hint);
          await advanceScenario(
            runtime,
            scenario.accepted.runId,
            scenario.coordinatorOutboxes,
            'Provider delay retry decision',
          );
          const due = await workerQuery<{
            retry_due_at: Date;
            retry_decision: string;
          }>(
            `select node.retry_due_at,attempt.retry_decision from app.node_runs node
         join app.node_attempts attempt on attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id
         where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, scenario.attempt.attempt_id],
          );
          expect(due[0]?.retry_decision).toBe('retry');
          const completedAt = stored[0]?.completed_at;
          const dueAt = due[0]?.retry_due_at;
          if (completedAt === undefined || dueAt === undefined)
            throw new Error('Provider retry dates are missing');
          expect(
            dueAt.getTime() - completedAt.getTime(),
          ).toBeGreaterThanOrEqual(hint);
        },
        async () => {
          if (scenario !== undefined) {
            await cancelProviderScenarioRun(scenario.accepted.runId);
            await advanceScenario(
              runtime,
              scenario.accepted.runId,
              scenario.coordinatorOutboxes,
              'Cancel rate-limit proof run',
            );
          }
          await closeProofRuntime(runtime);
        },
        'Provider retry delay',
      );
    },
  );

  it('restores fixture secret versions with a fresh revision and never changes revoked connections', async () => {
    if (connectionStore === undefined || fixtureEncryption === undefined)
      throw new Error('Connection fixture missing');
    const encryption = fixtureEncryption;
    const isolatedConnectionId = randomUUID();
    const seededVersion = randomUUID();
    const nextVersion = randomUUID();
    const seal = async (secretVersionId: string) => {
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          type: 'http_headers',
          headers: { authorization: plaintextSecret },
        }),
      );
      try {
        return await encryption.seal(plaintext, {
          workspaceId,
          connectionId: isolatedConnectionId,
          secretVersionId,
        });
      } finally {
        plaintext.fill(0);
      }
    };
    await connectionStore.createConnection({
      workspaceId,
      actorId,
      connectionId: isolatedConnectionId,
      secretVersionId: seededVersion,
      providerKey: 'http',
      authType: 'http_headers',
      name: 'Isolated reset proof',
      sealed: await seal(seededVersion),
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
    });
    await connectionStore.rotateConnectionSecret({
      workspaceId,
      actorId,
      connectionId: isolatedConnectionId,
      secretVersionId: nextVersion,
      expectedCurrentSecretVersionId: seededVersion,
      expectedAuthType: 'http_headers',
      sealed: await seal(nextVersion),
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
    });
    const read = async () =>
      (
        await withOwner((client) =>
          client.query<{
            current_secret_version_id: string;
            health_revision: string;
            status: string;
            last_tested_at: Date | null;
            last_healthy_at: Date | null;
            last_run_observed_at: Date | null;
            last_error_code: string | null;
            last_health_transition_source: string | null;
          }>(
            `select current_secret_version_id,health_revision::text,status,last_tested_at,
      last_healthy_at,last_run_observed_at,last_error_code,last_health_transition_source
      from app.connections where workspace_id=$1 and id=$2`,
            [workspaceId, isolatedConnectionId],
          ),
        )
      ).rows[0];
    const rotated = await read();
    if (rotated === undefined) throw new Error('Rotated fixture missing');
    const seeds = [
      { connectionId: isolatedConnectionId, secretVersionId: seededVersion },
    ];
    await resetProviderScenarioIsolation(seeds);
    const restored = await read();
    expect(restored).toEqual({
      current_secret_version_id: seededVersion,
      health_revision: String(BigInt(rotated.health_revision) + 1n),
      status: 'active',
      last_tested_at: null,
      last_healthy_at: null,
      last_run_observed_at: null,
      last_error_code: null,
      last_health_transition_source: 'rotation',
    });
    await resetProviderScenarioIsolation(seeds);
    expect(await read()).toEqual(restored);
    const revokedVersion = randomUUID();
    await connectionStore.rotateConnectionSecret({
      workspaceId,
      actorId,
      connectionId: isolatedConnectionId,
      secretVersionId: revokedVersion,
      expectedCurrentSecretVersionId: seededVersion,
      expectedAuthType: 'http_headers',
      sealed: await seal(revokedVersion),
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
    });
    await connectionStore.revokeConnection({
      workspaceId,
      actorId,
      connectionId: isolatedConnectionId,
    });
    const revoked = await read();
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.current_secret_version_id).toBe(revokedVersion);
    await resetProviderScenarioIsolation(seeds);
    expect(await read()).toEqual(revoked);
  });

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

  it.each(['http', 'slack'] as const)(
    'rejects a %s dispatch when its resolved secret rotates after the current-version assertion',
    async (target) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      if (connectionStore === undefined)
        throw new Error('Connection database missing');
      const apiConnectionDatabase = connectionStore;

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
                    type: 'http_headers',
                    headers: { authorization: 'Bearer rotated-http' },
                  }
                : {
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
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );

  it('uses an already accepted HTTP binding after connection sharing becomes restricted', async () => {
    if (!fixtureEncryption)
      throw new Error('HTTP attempt fixture encryption is missing');
    const runtime = await createHttpNodeAttemptProofRuntime(fixtureEncryption);
    try {
      const scenario = await admitProviderScenario(runtime, 'http');
      await withOwner((client) =>
        client.query(
          "update app.connections set access_mode='restricted',sharing_revision=sharing_revision+1 where workspace_id=$1 and id=$2",
          [workspaceId, connectionId],
        ),
      );
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Delegated HTTP after sharing change',
      );
      expect(
        await workerQuery('select status from app.node_attempts where id=$1', [
          scenario.attempt.attempt_id,
        ]),
      ).toEqual([{ status: 'succeeded' }]);
      expect(runtime.transportRequests).toHaveLength(1);
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Delegated HTTP completion',
      );
      expect(
        await workerQuery('select status from app.workflow_runs where id=$1', [
          scenario.accepted.runId,
        ]),
      ).toEqual([{ status: 'succeeded' }]);
    } finally {
      await withOwner((client) =>
        client.query(
          "update app.connections set access_mode='workspace',sharing_revision=sharing_revision+1 where workspace_id=$1 and id=$2",
          [workspaceId, connectionId],
        ),
      );
      await closeProofRuntime(runtime);
    }
  }, 30_000);

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
      const providerStarted = createOwnedBarrier(
        `${reason} HTTP provider start`,
      );
      let providerCalls = 0;
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        dispatchHttp: async (request) => {
          providerCalls += 1;
          providerStarted.resolve();
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
        // A POST: a GET only reads, so stopping it is simply canceled.
        const scenario = await admitProviderScenario(runtime, 'http_post');
        const published = await runtime.producer.publish(
          attemptJob(scenario.accepted.runId, scenario.attempt),
        );
        await providerStarted.promise;
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
        providerStarted.dispose();
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
        /^email:sha256:[0-9a-f]{64}$/u,
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
      const retryResolution = createOwnedBarrier(
        `${reason} retry resolution entry`,
      );
      const retryResolutionRelease = createOwnedBarrier(
        `${reason} retry resolution release`,
        25_000,
      );
      const durableAbort = createOwnedBarrier(
        `${reason} durable abort observation`,
      );
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
          if (entryPath === 'heartbeat' && result.control.kind === 'abort')
            durableAbort.resolve();
          return Promise.resolve();
        },
        beforeConnectionResolve: async (input) => {
          if (input.expectedProviderKey !== 'email') return;
          emailResolutions += 1;
          if (entryPath === 'heartbeat' && emailResolutions === 2) {
            retryResolution.resolve();
            await retryResolutionRelease.promise;
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
          await retryResolution.promise;
          await requestControl(scenario.accepted.runId);
          await durableAbort.promise;
          retryResolutionRelease.resolve();
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
        retryResolution.dispose();
        durableAbort.dispose();
        retryResolutionRelease.resolve();
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
    const providerStarted = createOwnedBarrier('heartbeat-loss provider start');
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
        providerStarted.resolve();
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
    try {
      const scenario = await admitProviderScenario(firstRuntime, 'email');
      const firstPublished = await firstRuntime.producer.publish(
        attemptJob(scenario.accepted.runId, scenario.attempt),
      );
      await providerStarted.promise;
      const abortedJob = await waitFor(
        () => firstRuntime.attemptQueue.getJob(firstPublished.jobId),
        (candidate) => candidate !== undefined,
      );
      if (abortedJob === undefined)
        throw new Error('Heartbeat-loss email job missing');
      // A repeat of the job finds the attempt running and leaves it to the
      // lease, so the job ends without settling anything.
      await waitFor(
        () => abortedJob.getState(),
        (state) => state === 'completed' || state === 'failed',
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
        outcome: 'reclaimed',
        result: {
          fenceToken: 2,
          outcome: 'reclaimed',
        },
      });
      const reclaimedOutboxEventId = reclaimed.result.outboxEventId;
      if (typeof reclaimedOutboxEventId !== 'string')
        throw new Error('Reclaim outbox event missing');
      expect(reclaimedOutboxEventId).toMatch(
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
            workspaceId,
            runId: scenario.accepted.runId,
            nodeRunId: scenario.attempt.node_run_id,
            attemptId: scenario.attempt.attempt_id,
            outboxEventId: reclaimedOutboxEventId,
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
            reclaimedOutboxEventId,
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
              reclaimedOutboxEventId,
              scenario.accepted.runId,
            ],
          ),
        ).resolves.toEqual([beforeDuplicate]);
        expect(providerKeys).toHaveLength(2);
      } finally {
        await closeProofRuntime(secondRuntime);
      }
    } finally {
      providerStarted.dispose();
      await closeProofRuntime(firstRuntime);
    }
  }, 30_000);

  it('derives a new provider identity when replaying an intentionally seeded terminal source without rewriting its history', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    const runtime = await createHttpNodeAttemptProofRuntime(encryption);
    let operator: ReturnType<typeof createOperatorCommandStore> | undefined;
    let replayStore:
      ReturnType<typeof createDatabaseOperatorRunReplayStore> | undefined;
    await runWithCleanup(
      async () => {
        operator = createOperatorCommandStore(
          parseOperatorDatabaseConfig({
            ...process.env,
            DATABASE_MAINTENANCE_URL: databaseUrl(operatorUrl),
          }),
        );
        replayStore = createDatabaseOperatorRunReplayStore(
          parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
            max: 1,
          }),
        );
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
        expect(sourceRow.provider_idempotency_key).toMatch(
          /^v1\.[0-9a-f]{64}$/u,
        );
        const sourceHistory = await readSourceRunHistory(source.accepted.runId);

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
              workspaceId,
            }),
          },
          workspaceId,
        });
        if (replayed.kind !== 'processed')
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
        const replayProvider = await attemptDelivery(
          replayed.runId,
          'provider',
        );
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
        await expect(
          readSourceRunHistory(source.accepted.runId),
        ).resolves.toEqual(sourceHistory);
      },
      async () => {
        const errors: unknown[] = [];
        if (replayStore !== undefined)
          await replayStore
            .close()
            .catch((error: unknown) => errors.push(error));
        if (operator !== undefined)
          await operator.close().catch((error: unknown) => errors.push(error));
        await closeProofRuntime(runtime).catch((error: unknown) => {
          errors.push(error);
        });
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'HTTP replay scenario cleanup failed',
          );
      },
      'HTTP replay scenario',
    );
  }, 30_000);
});
