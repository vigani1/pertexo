import { lockEventCoordination } from '../coordination/keys.js';
import { coordinateVerifiedWebhook } from './coordinate.js';
import {
  createEventCoordinationPreparation,
  closeEventCoordinationStore,
} from '../coordination/prepare.js';

import { WorkflowAlreadyRunningError } from '../../runs/commands/concurrency.js';
import { recordWorkflowTriggerSkip } from '../skips.js';
import type { WebhookAuthentication } from '@pertexo/contracts';
import {
  openWebhookResponse,
  webhookReplayWait,
} from './responses/admission.js';
import { readWebhookResponse } from './responses/read.js';
import type { WebhookResponseScope } from './responses/contract.js';

import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';
import type { DatabaseConfig } from '../../config.js';
import { acceptWorkflowRun } from '../../runs/commands/acceptance.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

import {
  readHealth,
  refreshWorkflowActivation,
} from '../reconciliation/database.js';
import { canManageWorkflowTrigger } from '../management-access.js';
import {
  authorizeWebhookTriggerReader,
  createWebhookDeliveryLog,
  insertWebhookDelivery,
} from './deliveries.js';
import {
  deleteExpiredReplay,
  lockEndpointDedupeKey,
  readLockedReplay,
  resolveExactReplay,
  type WebhookReplayIdentity,
} from './replay.js';
import {
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  WebhookTriggerStateError,
  WebhookWorkflowPausedError,
} from './errors.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
  withWorkspaceReadTransaction,
} from '../../tenant-access/transactions.js';
import {
  uuidSchema,
  type Command,
  type WebhookConfig,
  type WebhookTriggerDatabase,
} from './runtime/contract.js';
import {
  claimWebhookCommand,
  completeWebhookCommand,
  insertSecret,
} from './runtime/receipts.js';
import {
  oneHealth,
  mapSecret,
  executableProjection,
  lockEligibleEndpoint,
} from './runtime/state.queries.js';
export {
  WebhookTriggerStateError,
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  WebhookWorkflowPausedError,
};
export {
  type SealedWebhookTriggerSecret,
  type WebhookVerificationReference,
  type AcceptVerifiedWebhookDeliveryInput,
  type WebhookTriggerDatabase,
} from './runtime/contract.js';
export function createWebhookTriggerDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WebhookTriggerDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const eventPreparation = createEventCoordinationPreparation();
  const command = <T>(
    input: Command,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withTenantScopedClient(
      pool,
      {
        workspaceId: uuidSchema.parse(input.workspaceId),
        actorId: uuidSchema.parse(input.actorId),
      },
      async (client) => {
        if (await canManageWorkflowTrigger(client, input)) return work(client);
        throw new WebhookTriggerNotFoundError();
      },
    );

  return Object.freeze({
    readResponse: (input: WebhookResponseScope) =>
      readWebhookResponse(pool, input),
    configureAuthentication: (
      input: Parameters<WebhookTriggerDatabase['configureAuthentication']>[0],
    ) =>
      command(input, async (client) => {
        const operation = 'webhook.trigger.authentication.configure';
        if (await claimWebhookCommand(client, input, operation))
          return {
            trigger: await oneHealth(
              client,
              input.workspaceId,
              input.triggerId,
            ),
            replayed: true,
            rotated: false,
          };
        const result = await client.query<{
          authentication: WebhookAuthentication;
        }>(
          `select authentication from app.webhook_trigger_endpoints
            where workspace_id=$1 and trigger_id=$2 and status='active' for update`,
          [input.workspaceId, input.triggerId],
        );
        const current = result.rows[0]?.authentication;
        if (current === undefined) throw new WebhookTriggerNotFoundError();
        const next = input.authentication;
        const rotated =
          current.mode !== next.mode ||
          (current.mode === 'header_secret' &&
            next.mode === 'header_secret' &&
            current.headerName !== next.headerName);
        if (rotated) {
          const secret = await insertSecret(client, input, input.secret);
          await client.query(
            `update app.webhook_trigger_endpoints
            set authentication=$3,endpoint_key_hash=$4,current_secret_version_id=$5,
                previous_secret_version_id=null,previous_secret_valid_until=null,updated_at=clock_timestamp()
            where workspace_id=$1 and trigger_id=$2`,
            [
              input.workspaceId,
              input.triggerId,
              JSON.stringify(next),
              input.endpointKeyHash,
              secret.id,
            ],
          );
        } else {
          await client.query(
            `update app.webhook_trigger_endpoints set authentication=$3,updated_at=clock_timestamp()
            where workspace_id=$1 and trigger_id=$2`,
            [input.workspaceId, input.triggerId, JSON.stringify(next)],
          );
        }
        await completeWebhookCommand(client, input, operation);
        return {
          trigger: await oneHealth(client, input.workspaceId, input.triggerId),
          replayed: false,
          rotated,
        };
      }),
    provision: (input: Parameters<WebhookTriggerDatabase['provision']>[0]) =>
      command(input, async (client) => {
        const operation = 'webhook.trigger.provision';
        if (await claimWebhookCommand(client, input, operation))
          return oneHealth(client, input.workspaceId, input.triggerId);
        const trigger = await client.query<{
          workflow_id: string;
          status: string;
        }>(
          `select workflow_id,status from app.workflow_triggers where workspace_id=$1 and id=$2
             and kind='webhook' for update`,
          [input.workspaceId, uuidSchema.parse(input.triggerId)],
        );
        const row = trigger.rows[0];
        if (row === undefined) throw new WebhookTriggerNotFoundError();
        const status = row.status;
        if (status === 'desired' || status === 'pending')
          throw new WebhookTriggerStateError('setting_up');
        if (status === 'active' || status === 'degraded')
          throw new WebhookTriggerStateError('provisioned');
        if (status !== 'configuration_required')
          throw new WebhookTriggerStateError('unavailable');
        const secret = await insertSecret(client, input, input.secret);
        await client.query(
          `insert into app.webhook_trigger_endpoints
            (id,workspace_id,trigger_id,endpoint_key_hash,current_secret_version_id)
           values($1,$2,$3,$4,$5)`,
          [
            uuidSchema.parse(input.endpointId),
            input.workspaceId,
            input.triggerId,
            digestSchema.parse(input.endpointKeyHash),
            secret.id,
          ],
        );
        await client.query(
          `update app.workflow_triggers set status='active',health_status='healthy',
             reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2`,
          [input.workspaceId, input.triggerId],
        );
        await refreshWorkflowActivation(
          client,
          input.workspaceId,
          row.workflow_id,
        );
        await completeWebhookCommand(client, input, operation);
        return oneHealth(client, input.workspaceId, input.triggerId);
      }),
    rotateEndpoint: (
      input: Parameters<WebhookTriggerDatabase['rotateEndpoint']>[0],
    ) =>
      command(input, async (client) => {
        const operation = 'webhook.trigger.endpoint.rotate';
        if (await claimWebhookCommand(client, input, operation))
          return oneHealth(client, input.workspaceId, input.triggerId);
        const result = await client.query(
          `update app.webhook_trigger_endpoints set endpoint_key_hash=$3,updated_at=clock_timestamp()
            where workspace_id=$1 and trigger_id=$2 and status='active'`,
          [
            input.workspaceId,
            input.triggerId,
            digestSchema.parse(input.endpointKeyHash),
          ],
        );
        if (result.rowCount !== 1) throw new WebhookTriggerNotFoundError();
        await completeWebhookCommand(client, input, operation);
        return oneHealth(client, input.workspaceId, input.triggerId);
      }),
    rotateSecret: (
      input: Parameters<WebhookTriggerDatabase['rotateSecret']>[0],
    ) =>
      command(input, async (client) => {
        const operation = 'webhook.trigger.secret.rotate';
        const keyedCommand = {
          ...input,
          requestHash: createHash('sha256')
            .update(`${input.requestHash}\0${input.endpointKeyHash}`)
            .digest('hex'),
        };
        if (await claimWebhookCommand(client, keyedCommand, operation))
          return oneHealth(client, input.workspaceId, input.triggerId);
        const endpoint = await client.query<{
          current_secret_version_id: string;
          authentication: WebhookAuthentication;
        }>(
          `select current_secret_version_id,authentication from app.webhook_trigger_endpoints
             where workspace_id=$1 and trigger_id=$2 and endpoint_key_hash=$3
               and status='active' for update`,
          [
            input.workspaceId,
            input.triggerId,
            digestSchema.parse(input.endpointKeyHash),
          ],
        );
        const row = endpoint.rows[0];
        if (row === undefined || row.authentication.mode === 'secret_url')
          throw new WebhookTriggerNotFoundError();
        const current = row.current_secret_version_id;
        const secret = await insertSecret(client, input, input.secret);
        await client.query(
          `update app.webhook_trigger_endpoints set current_secret_version_id=$3,
             previous_secret_version_id=$4,
             previous_secret_valid_until=clock_timestamp()+interval '5 minutes',
             updated_at=clock_timestamp() where workspace_id=$1 and trigger_id=$2`,
          [input.workspaceId, input.triggerId, secret.id, current],
        );
        await completeWebhookCommand(client, keyedCommand, operation);
        return oneHealth(client, input.workspaceId, input.triggerId);
      }),
    getHealth: (input: Parameters<WebhookTriggerDatabase['getHealth']>[0]) =>
      withTenantScopedClient(
        pool,
        {
          workspaceId: uuidSchema.parse(input.workspaceId),
          actorId: uuidSchema.parse(input.actorId),
        },
        async (client) => {
          await authorizeWebhookTriggerReader(
            client,
            input.workspaceId,
            input.actorId,
            input.workflowId,
          );
          return readHealth(
            client,
            input.workspaceId,
            uuidSchema.parse(input.workflowId),
          );
        },
      ),
    resolveVerification: async (
      endpointKeyHashInput: Parameters<
        WebhookTriggerDatabase['resolveVerification']
      >[0],
    ) => {
      const endpointKeyHash = digestSchema.parse(endpointKeyHashInput);
      const result = await pool.query<
        Record<string, unknown> & { authentication: WebhookAuthentication }
      >('select * from app.resolve_public_webhook_endpoint($1::char(64))', [
        endpointKeyHash,
      ]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const currentSecret = mapSecret(row, 'current');
      if (currentSecret === undefined) return null;
      const previousSecret = mapSecret(row, 'previous');
      const workspaceId = uuidSchema.parse(row.workspace_id);
      const triggerId = uuidSchema.parse(row.trigger_id);
      const workflowVersionId = uuidSchema.parse(row.workflow_version_id);
      const config = await withWorkspaceReadTransaction(
        pool,
        workspaceId,
        async (transaction) => {
          const result = await transaction.db.execute<{
            desired_config: WebhookConfig;
          }>(
            sql`select desired_config from app.workflow_triggers where workspace_id=${transaction.workspaceId} and id=${triggerId} and workflow_version_id=${workflowVersionId}`,
          );
          return result.rows[0]?.desired_config;
        },
      );
      return Object.freeze({
        endpointId: uuidSchema.parse(row.endpoint_id),
        endpointKeyHash,
        workspaceId: uuidSchema.parse(row.workspace_id),
        triggerId: uuidSchema.parse(row.trigger_id),
        workflowId: uuidSchema.parse(row.workflow_id),
        workflowVersionId: uuidSchema.parse(row.workflow_version_id),
        nodeId: z.string().parse(row.node_id),
        databaseTime: z.date().parse(row.database_time),
        authentication: row.authentication,
        ...(config?.runInput === undefined
          ? {}
          : { runInputMode: config.runInput }),
        currentSecret,
        ...(previousSecret === undefined
          ? {}
          : {
              previousSecret: Object.freeze({
                ...previousSecret,
                validUntil: z.date().parse(row.previous_secret_valid_until),
              }),
            }),
      });
    },
    consumeIngressLimit: async (endpointKeyHashInput: string) => {
      const result = await pool.query<{
        allowed: boolean;
        retry_after_seconds: number;
      }>('select * from app.consume_webhook_ingress_limit($1::char(64))', [
        digestSchema.parse(endpointKeyHashInput),
      ]);
      const decision = result.rows[0];
      if (decision?.allowed !== true)
        throw new WebhookIngressRateLimitExceededError(
          z.number().int().min(1).max(60).parse(decision?.retry_after_seconds),
        );
    },
    acceptVerifiedDelivery: async (
      input: Parameters<WebhookTriggerDatabase['acceptVerifiedDelivery']>[0],
    ) => {
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
      const readCandidate = (checkReplay: boolean) =>
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
      let candidate = await readCandidate(true);
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
              await lockEventCoordination(
                transaction.workspaceId,
                transaction.db,
              );
            await lockEndpointDedupeKey(transaction, replayIdentity);
            const replay = await readLockedReplay(transaction, replayIdentity);
            await lockEligibleEndpoint(
              transaction,
              verification,
              input.verifiedSecretVersionId,
              replay?.active === true,
            );
            if (replay?.active === true) {
              const replayed = resolveExactReplay(replay, requestFingerprint);
              await insertWebhookDelivery(transaction, verification, {
                outcome:
                  'skipped' in replayed
                    ? 'skipped'
                    : 'coordinated' in replayed
                      ? 'coordinated'
                      : 'replayed',
                signatureCheck: 'verified',
                replayCheck: 'duplicate',
                bodyBytes: input.bodyBytes,
                ...(replay.coordination_event_id === null
                  ? {}
                  : { coordinationEventId: replay.coordination_event_id }),
                ...('runId' in replayed
                  ? { runId: replayed.runId }
                  : 'coordinated' in replayed
                    ? { coordinationEventId: replayed.eventId }
                    : {}),
                dedupeKind,
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
            if (replay !== undefined)
              await deleteExpiredReplay(transaction, replayIdentity);

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
              return coordinateVerifiedWebhook(
                transaction,
                input,
                runInput,
                prepared,
                projection,
                deliveryId,
                dedupeKind,
              );
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
              await transaction.db.execute(
                sql`release savepoint webhook_run_admission`,
              );
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
            await transaction.db.execute(
              sql`release savepoint webhook_run_admission`,
            );
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
              ...(seconds === undefined
                ? {}
                : { responseWaitSeconds: seconds }),
            });
          },
        );
        if (receipt !== undefined) return receipt;
        // The preliminary live receipt expired behind the admission fence.
        // Prepare once outside locks; the next pass always has fresh event input.
        candidate = await readCandidate(false);
      }
    },
    ...createWebhookDeliveryLog(pool),
    close: () =>
      closeEventCoordinationStore(() => lease.close(), eventPreparation),
  });
}
