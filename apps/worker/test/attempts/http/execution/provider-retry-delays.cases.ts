import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { createHttpNodeAttemptProofRuntime } from '../../../support/attempts/http-node-attempt.runtime.js';

import {
  actorId,
  connectionStore,
  cancelProviderScenarioRun,
  plaintextSecret,
  resetProviderScenarioIsolation,
  withOwner,
  workerQuery,
  workspaceId,
} from '../../../support/attempts/http-node-attempt.js';
import { runWithCleanup } from '../../../support/infrastructure/test-operation.js';
import {
  fixtureEncryption,
  publishAndWaitForCompletion,
  attemptJob,
  admitProviderScenario,
  advanceScenario,
  closeProofRuntime,
} from '../fixture.js';

export function registerProviderRetryDelays(): void {
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
}
