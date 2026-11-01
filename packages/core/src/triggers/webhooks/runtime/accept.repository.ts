import { WorkflowAlreadyRunningError } from '../../../runs/commands/acceptance/errors.js';
import { webhookTriggerReplayRecords as replays } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { lockEventCoordination } from '../../coordination/keys.repository.js';
import type { createEventCoordinationPreparation } from '../../coordination/prepare.js';
import { recordWorkflowTriggerSkip } from '../../skips.repository.js';
import {
  coordinateVerifiedWebhook,
  startWebhookRun,
} from '../coordinate.repository.js';

import {
  openWebhookResponse,
  webhookReplayWait,
} from '../responses/admission.repository.js';

import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';

import type { WebhookReplayIdentity } from '../contract.js';
import { insertWebhookDelivery } from '../deliveries.repository.js';
import {
  replayDeliveryOutcome,
  replayDeliveryReference,
  resolveExactReplay,
} from '../replay-receipt.js';
import {
  deleteExpiredReplay,
  lockEndpointDedupeKey,
  readLockedReplay,
  recordReplayResult,
} from '../replay.repository.js';

import {
  withWorkspaceReadTransaction,
  withWorkspaceTransaction,
} from '@pertexo/database/primitives';
import type {
  AcceptVerifiedWebhookDeliveryInput,
  WebhookAcceptance,
} from './contract.js';

import {
  executableProjection,
  lockEligibleEndpoint,
  readTriggerConfig,
} from './state.queries.js';
import type { WorkspaceTurns } from './workspace-turns.js';

export async function acceptVerifiedWebhookDelivery(
  pool: Pool,
  {
    eventPreparation,
    turns,
  }: Readonly<{
    eventPreparation: ReturnType<typeof createEventCoordinationPreparation>;
    turns: WorkspaceTurns;
  }>,
  input: AcceptVerifiedWebhookDeliveryInput,
): Promise<WebhookAcceptance> {
  const verification = input.verification;
  const requestFingerprint = input.requestFingerprint;
  // Only a sender's own key names a repeat. Identical bytes without one are separate
  // events; business dedupe is event coordination's job (ADR 026).
  const replayIdentity: WebhookReplayIdentity | undefined =
    input.idempotencyKeyHash === undefined
      ? undefined
      : {
          endpointId: verification.endpointId,
          dedupeKeyHash: input.idempotencyKeyHash,
        };
  const readCandidate = ({ checkReplay }: Readonly<{ checkReplay: boolean }>) =>
    withWorkspaceReadTransaction(
      pool,
      verification.workspaceId,
      async (transaction) => {
        if (checkReplay && replayIdentity !== undefined) {
          const replay = await transaction.db
            .select({ one: sql`1` })
            .from(replays)
            .where(
              and(
                eq(replays.workspaceId, transaction.workspaceId),
                eq(replays.endpointId, replayIdentity.endpointId),
                eq(replays.dedupeKeyHash, replayIdentity.dedupeKeyHash),
                sql`${replays.expiresAt}>clock_timestamp()`,
              ),
            );
          if (replay.length > 0) return { replay: true as const };
        }
        const config = await readTriggerConfig(
          transaction,
          verification.triggerId,
          verification.workflowVersionId,
        );
        return {
          replay: false as const,
          policy: config?.coordination,
          runInput: input.runInput,
        };
      },
    );
  let candidate = await readCandidate({ checkReplay: true });
  for (;;) {
    const runInput = candidate.replay ? undefined : candidate.runInput;
    const prepared = candidate.replay
      ? undefined
      : await eventPreparation.prepare(
          candidate.policy,
          candidate.runInput,
          input.signal,
        );
    const receipt = await turns.take(
      verification.workspaceId,
      input.signal,
      () =>
        withWorkspaceTransaction(
          pool,
          verification.workspaceId,
          async (transaction) => {
            await transaction.db.execute(
              sql`select app.lock_workspace_run_admission(${transaction.workspaceId})`,
            );
            if (prepared !== undefined)
              await lockEventCoordination(
                transaction.workspaceId,
                transaction.db,
              );
            const replay =
              replayIdentity === undefined
                ? undefined
                : await readReplayUnderLock(transaction, replayIdentity);
            await lockEligibleEndpoint(
              transaction,
              verification,
              input.verifiedSecretVersionId,
              { replaying: replay?.active ?? false },
            );
            if (replay?.active) {
              const replayed = resolveExactReplay(replay, requestFingerprint);
              await insertWebhookDelivery(transaction, verification, {
                outcome: replayDeliveryOutcome(replayed),
                signatureCheck: 'verified',
                replayCheck: 'duplicate',
                bodyBytes: input.bodyBytes,
                ...(replay.coordination_event_id === null
                  ? {}
                  : { coordinationEventId: replay.coordination_event_id }),
                ...replayDeliveryReference(replayed),
              });
              if ('skipped' in replayed || 'coordinated' in replayed)
                return replayed;
              const seconds = await webhookReplayWait(
                transaction,
                replayed.runId,
              );
              return {
                ...replayed,
                ...(seconds === undefined
                  ? {}
                  : { responseWaitSeconds: seconds }),
              };
            }
            if (candidate.replay) return undefined;
            if (replay !== undefined && replayIdentity !== undefined)
              await deleteExpiredReplay(transaction, replayIdentity);

            return acceptNewWebhookDelivery(transaction, input, {
              requestFingerprint,
              replayIdentity,
              runInput,
              prepared,
            });
          },
        ),
    );
    if (receipt !== undefined) return receipt;
    // The preliminary live receipt expired behind the admission fence.
    // Prepare once outside locks; the next pass always has fresh event input.
    candidate = await readCandidate({ checkReplay: false });
  }
}

async function readReplayUnderLock(
  transaction: WorkspaceTransaction,
  identity: WebhookReplayIdentity,
) {
  await lockEndpointDedupeKey(transaction, identity);
  return readLockedReplay(transaction, identity);
}

async function acceptNewWebhookDelivery(
  transaction: WorkspaceTransaction,
  input: AcceptVerifiedWebhookDeliveryInput,
  {
    requestFingerprint,
    replayIdentity,
    runInput,
    prepared,
  }: Readonly<{
    requestFingerprint: string;
    replayIdentity: WebhookReplayIdentity | undefined;
    runInput: unknown;
    prepared: Awaited<
      ReturnType<
        ReturnType<typeof createEventCoordinationPreparation>['prepare']
      >
    >;
  }>,
): Promise<WebhookAcceptance> {
  const verification = input.verification;
  const deliveryId = generatePersistedId();
  if (replayIdentity !== undefined)
    await transaction.db.insert(replays).values({
      workspaceId: transaction.workspaceId,
      endpointId: verification.endpointId,
      dedupeKeyHash: replayIdentity.dedupeKeyHash,
      requestFingerprint,
      deliveryId,
      expiresAt: sql`clock_timestamp()+interval '24 hours'`,
    });
  const projection = await executableProjection(
    transaction,
    verification.workflowVersionId,
  );
  if (prepared !== undefined)
    return coordinateVerifiedWebhook(transaction, input, {
      runInput,
      prepared,
      projection,
      deliveryId,
    });
  const initial = input.checkpointFactory(projection);
  let accepted;
  await transaction.db.execute(sql`savepoint webhook_run_admission`);
  try {
    accepted = await startWebhookRun(transaction, input, {
      initial,
      key: deliveryId,
      runInput,
    });
  } catch (error) {
    if (!(error instanceof WorkflowAlreadyRunningError)) throw error;
    await transaction.db.execute(
      sql`rollback to savepoint webhook_run_admission`,
    );
    await transaction.db.execute(sql`release savepoint webhook_run_admission`);
    await insertWebhookDelivery(transaction, verification, {
      id: deliveryId,
      outcome: 'skipped',
      signatureCheck: 'verified',
      replayCheck: 'new',
      bodyBytes: input.bodyBytes,
    });
    await recordReplayResult(transaction, deliveryId, {
      skipReason: 'concurrency_limit',
    });
    await recordWorkflowTriggerSkip(
      transaction,
      verification.workflowId,
      'webhook',
    );
    return Object.freeze({
      skipped: true as const,
      reason: 'concurrency_limit' as const,
    });
  }
  await transaction.db.execute(sql`release savepoint webhook_run_admission`);
  await insertWebhookDelivery(transaction, verification, {
    id: deliveryId,
    outcome: 'accepted',
    signatureCheck: 'verified',
    replayCheck: 'new',
    bodyBytes: input.bodyBytes,
    runId: accepted.runId,
  });
  await recordReplayResult(transaction, deliveryId, {
    workflowRunId: accepted.runId,
  });
  const seconds = await openWebhookResponse(
    transaction,
    verification.triggerId,
    accepted.runId,
  );
  return Object.freeze({
    runId: accepted.runId,
    replayed: false,
    ...(seconds === undefined ? {} : { responseWaitSeconds: seconds }),
  });
}
