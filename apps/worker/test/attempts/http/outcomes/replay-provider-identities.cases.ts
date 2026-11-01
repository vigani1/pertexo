import { randomUUID } from 'node:crypto';
import { JOB_NAME } from '@pertexo/queue';

import { canonicalOutboxPayloadChecksum } from '@pertexo/core/outbox';

import { createOperatorCommandStore } from '@pertexo/core/runs';
import { parseOperatorDatabaseConfig } from '@pertexo/database/platform';
import { parseDatabaseConfig } from '@pertexo/database/testing';

import { expect, it } from 'vitest';

import { createHttpNodeAttemptProofRuntime } from '../../../support/attempts/http-node-attempt.runtime.js';
import { createDatabaseOperatorRunReplayStore } from '../../../../src/operator/run-replay.js';
import {
  attemptDelivery,
  continuation,
  databaseUrl,
  operatorUrl,
  withOwner,
  workerQuery,
  workerUrl,
  workspaceId,
} from '../../../support/attempts/http-node-attempt.js';
import { runWithCleanup } from '../../../support/infrastructure/test-operation.js';
import {
  fixtureEncryption,
  readSourceRunHistory,
  publishAndWaitForCompletion,
  attemptJob,
  admitProviderScenario,
  advanceScenario,
  closeProofRuntime,
} from '../fixture.js';

export function registerReplayProviderIdentities(): void {
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
}
