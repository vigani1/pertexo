import { webhookTriggerReplayRecords as replays } from '../../../schema/triggers/deliveries.js';
import { workflowTriggers } from '../../../schema/authoring/workflows.js';
import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';
import { lockEventCoordination } from '../../coordination/keys.repository.js';
import { coordinateVerifiedWebhook } from '../coordinate.repository.js';
import type { createEventCoordinationPreparation } from '../../coordination/prepare.js';
import { WorkflowAlreadyRunningError } from '../../../runs/commands/concurrency.js';
import { recordWorkflowTriggerSkip } from '../../skips.repository.js';

import {
  openWebhookResponse,
  webhookReplayWait,
} from '../responses/admission.repository.js';

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';

import { sha256HexSchema as digestSchema } from '../../../platform/persisted-primitives.js';

import { acceptWorkflowRun } from '../../../runs/commands/acceptance.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';

import { insertWebhookDelivery } from '../deliveries.repository.js';
import {
  deleteExpiredReplay,
  lockEndpointDedupeKey,
  readLockedReplay,
  resolveExactReplay,
} from '../replay.repository.js';
import type { WebhookReplayIdentity } from '../contract.js';

import {
  withWorkspaceTransaction,
  withWorkspaceReadTransaction,
} from '../../../tenant-access/transactions.js';
import { uuidSchema } from '../input.js';
import type { WebhookConfig, WebhookTriggerDatabase } from './contract.js';

import { executableProjection, lockEligibleEndpoint } from './state.queries.js';

export async function acceptVerifiedWebhookDelivery(
  pool: Pool,
  eventPreparation: ReturnType<typeof createEventCoordinationPreparation>,
  input: Parameters<WebhookTriggerDatabase['acceptVerifiedDelivery']>[0],
): ReturnType<WebhookTriggerDatabase['acceptVerifiedDelivery']> {
  const verification = input.verification;
  const requestFingerprint = digestSchema.parse(input.requestFingerprint);
  const dedupeKind =
    input.idempotencyKeyHash === undefined ? 'fingerprint' : 'keyed';
  const dedupeKeyHash = digestSchema.parse(
    input.idempotencyKeyHash ?? requestFingerprint,
  );
  const replayIdentity: WebhookReplayIdentity = {
    endpointId: uuidSchema.parse(verification.endpointId),
    dedupeKind,
    dedupeKeyHash,
  };
  const readCandidate = ({ checkReplay }: Readonly<{ checkReplay: boolean }>) =>
    withWorkspaceReadTransaction(
      pool,
      verification.workspaceId,
      async (transaction) => {
        if (checkReplay) {
          const replay = await transaction.db
            .select({ one: sql`1` })
            .from(replays)
            .where(
              and(
                eq(replays.workspaceId, transaction.workspaceId),
                eq(replays.endpointId, replayIdentity.endpointId),
                eq(replays.dedupeKind, dedupeKind),
                eq(replays.dedupeKeyHash, dedupeKeyHash),
                sql`${replays.expiresAt}>clock_timestamp()`,
              ),
            );
          if (replay.length > 0) return { replay: true as const };
        }
        const row = (
          await transaction.db
            .select({
              config: sql<WebhookConfig>`${workflowTriggers.desiredConfig}`,
            })
            .from(workflowTriggers)
            .where(
              and(
                eq(workflowTriggers.workspaceId, transaction.workspaceId),
                eq(workflowTriggers.id, verification.triggerId),
                eq(
                  workflowTriggers.workflowVersionId,
                  verification.workflowVersionId,
                ),
              ),
            )
        )[0];
        const config = row?.config;
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
    const receipt = await withWorkspaceTransaction(
      pool,
      uuidSchema.parse(verification.workspaceId),
      async (transaction) => {
        await transaction.db.execute(
          sql`select app.lock_workspace_run_admission(${transaction.workspaceId})`,
        );
        if (prepared !== undefined)
          await lockEventCoordination(transaction.workspaceId, transaction.db);
        await lockEndpointDedupeKey(transaction, replayIdentity);
        const replay = await readLockedReplay(transaction, replayIdentity);
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
            dedupeKind,
          });
          if ('skipped' in replayed || 'coordinated' in replayed)
            return replayed;
          const seconds = await webhookReplayWait(transaction, replayed.runId);
          return {
            ...replayed,
            ...(seconds === undefined ? {} : { responseWaitSeconds: seconds }),
          };
        }
        if (candidate.replay) return undefined;
        if (replay !== undefined)
          await deleteExpiredReplay(transaction, replayIdentity);

        return acceptNewWebhookDelivery(transaction, input, {
          requestFingerprint,
          replayIdentity,
          runInput,
          prepared,
        });
      },
    );
    if (receipt !== undefined) return receipt;
    // The preliminary live receipt expired behind the admission fence.
    // Prepare once outside locks; the next pass always has fresh event input.
    candidate = await readCandidate({ checkReplay: false });
  }
}

function replayDeliveryOutcome(
  replayed: ReturnType<typeof resolveExactReplay>,
): Parameters<typeof insertWebhookDelivery>[2]['outcome'] {
  if ('skipped' in replayed) {
    return 'skipped';
  }
  if ('coordinated' in replayed) {
    return 'coordinated';
  }
  return 'replayed';
}

function replayDeliveryReference(
  replayed: ReturnType<typeof resolveExactReplay>,
): Pick<
  Parameters<typeof insertWebhookDelivery>[2],
  'runId' | 'coordinationEventId'
> {
  if ('runId' in replayed) {
    return { runId: replayed.runId };
  }
  if ('coordinated' in replayed) {
    return { coordinationEventId: replayed.eventId };
  }
  return {};
}

async function acceptNewWebhookDelivery(
  transaction: WorkspaceTransaction,
  input: Parameters<WebhookTriggerDatabase['acceptVerifiedDelivery']>[0],
  {
    requestFingerprint,
    replayIdentity,
    runInput,
    prepared,
  }: Readonly<{
    requestFingerprint: string;
    replayIdentity: WebhookReplayIdentity;
    runInput: Parameters<
      WebhookTriggerDatabase['acceptVerifiedDelivery']
    >[0]['runInput'];
    prepared: Awaited<
      ReturnType<
        ReturnType<typeof createEventCoordinationPreparation>['prepare']
      >
    >;
  }>,
): ReturnType<WebhookTriggerDatabase['acceptVerifiedDelivery']> {
  const verification = input.verification;
  const { dedupeKind, dedupeKeyHash } = replayIdentity;
  const deliveryId = generatePersistedId();
  const retention =
    dedupeKind === 'keyed'
      ? sql`interval '24 hours'`
      : sql`interval '5 minutes'`;
  await transaction.db.insert(replays).values({
    workspaceId: transaction.workspaceId,
    endpointId: verification.endpointId,
    dedupeKind,
    dedupeKeyHash,
    requestFingerprint,
    deliveryId,
    expiresAt: sql`clock_timestamp()+${retention}`,
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
      dedupeKind,
    });
  const initial = input.checkpointFactory(projection);
  let accepted;
  await transaction.db.execute(sql`savepoint webhook_run_admission`);
  try {
    accepted = await acceptWorkflowRun(transaction, {
      initialCheckpoint: initial.checkpoint,
      ...(initial.validateInput === undefined
        ? {}
        : { validateInput: initial.validateInput }),
      keyHash: createHash('sha256').update(deliveryId).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: requestFingerprint,
      scope: `webhook:${verification.endpointId}`,
      triggerType: 'webhook',
      workflowId: verification.workflowId,
      workflowVersionId: verification.workflowVersionId,
      runInput,
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
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
      dedupeKind,
    });
    await transaction.db
      .update(replays)
      .set({ skipReason: 'concurrency_limit' })
      .where(
        and(
          eq(replays.workspaceId, transaction.workspaceId),
          eq(replays.deliveryId, deliveryId),
        ),
      );
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
    dedupeKind,
  });
  await transaction.db
    .update(replays)
    .set({ workflowRunId: accepted.runId })
    .where(
      and(
        eq(replays.workspaceId, transaction.workspaceId),
        eq(replays.deliveryId, deliveryId),
      ),
    );
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
