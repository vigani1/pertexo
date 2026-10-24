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
import { sql } from 'drizzle-orm';
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
  type WebhookReplayIdentity,
} from '../replay.repository.js';

import {
  withWorkspaceTransaction,
  withWorkspaceReadTransaction,
} from '../../../tenant-access/transactions.js';
import {
  uuidSchema,
  type WebhookConfig,
  type WebhookTriggerDatabase,
} from './contract.js';

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
          const replay = await transaction.db.execute(
            sql`select 1 from app.webhook_trigger_replay_records where workspace_id=${transaction.workspaceId} and endpoint_id=${replayIdentity.endpointId} and dedupe_kind=${dedupeKind} and dedupe_key_hash=${dedupeKeyHash} and expires_at>clock_timestamp()`,
          );
          if (replay.rows.length > 0) return { replay: true as const };
        }
        const row = (
          await transaction.db.execute<{ desired_config: WebhookConfig }>(
            sql`select desired_config from app.workflow_triggers where workspace_id=${transaction.workspaceId} and id=${verification.triggerId} and workflow_version_id=${verification.workflowVersionId}`,
          )
        ).rows[0];
        const config = row?.desired_config;
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
  await transaction.db.execute(sql`
            insert into app.webhook_trigger_replay_records
              (workspace_id,endpoint_id,dedupe_kind,dedupe_key_hash,
               request_fingerprint,delivery_id,expires_at)
            values(${transaction.workspaceId},${verification.endpointId},${dedupeKind},
              ${dedupeKeyHash},${requestFingerprint},${deliveryId},
              clock_timestamp()+case when ${dedupeKind}='keyed'
                then interval '24 hours' else interval '5 minutes' end)
          `);
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
    await transaction.db.execute(
      sql`update app.webhook_trigger_replay_records set skip_reason='concurrency_limit' where workspace_id=${transaction.workspaceId} and delivery_id=${deliveryId}`,
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
  await transaction.db.execute(sql`
            update app.webhook_trigger_replay_records set workflow_run_id=${accepted.runId}
             where workspace_id=${transaction.workspaceId} and delivery_id=${deliveryId}
          `);
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
