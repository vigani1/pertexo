import { createDatabasePool } from './postgres-telemetry.js';
import { createHash } from 'node:crypto';

import { z } from 'zod';
import {
  FailureNotificationContextV1Schema,
  type FailureNotificationContextV1,
  type FailureNotificationDeliveryResultV1,
} from '@pertexo/workflow-model/failure-notification';

import type { DatabaseConfig } from './config.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';
import { withTenantScopedClient } from './workspace.js';
import { FailureNotificationStateError } from './failure-notification-errors.js';
import { createFailureNotificationDestinationStore } from './failure-notification-destination-store.js';
import { createFailureNotificationCompletionStore } from './failure-notification-completion-store.js';
import {
  auditFailureNotification as audit,
  failureNotificationChecksumSchema as checksumSchema,
  failureNotificationIdentitySchema as identitySchema,
} from './failure-notification-store-support.js';

export { FailureNotificationStateError } from './failure-notification-errors.js';

export type FailureNotificationDelivery = Readonly<{
  outboxEventId: string;
  payloadChecksum: string;
}>;

export type FailureNotificationClaimResult =
  | Readonly<{ kind: 'busy' | 'terminal' }>
  | Readonly<{
      kind: 'ready';
      attemptNumber: number;
      context: FailureNotificationContextV1;
      destinationId: string;
      destinationConfigVersion: number;
      idempotencyKey: string;
      sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
      connectionSecretVersionId: string;
      deliveryBinding?: string;
      deliveryUnresolved: boolean;
    }>;

type FailureNotificationResolvedDestinationBase = Readonly<{
  connectionId: string;
  secretVersionId: string;
  sealed: Readonly<{
    schemaVersion: 1;
    kmsKeyReference: string;
    encryptedDataKey: string;
    ciphertext: string;
    nonce: string;
    tag: string;
  }>;
}>;

export type FailureNotificationResolvedDestination =
  | (FailureNotificationResolvedDestinationBase &
      Readonly<{ kind: 'slack'; channelId: string }>)
  | (FailureNotificationResolvedDestinationBase &
      Readonly<{ kind: 'email'; toEmail: string }>);

export interface FailureNotificationStore {
  claimDelivery(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      delivery: FailureNotificationDelivery;
      recoverySeconds: number;
      maxAttempts: number;
    }>,
  ): Promise<FailureNotificationClaimResult>;
  completeDelivery(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      attemptNumber: number;
      maxAttempts: number;
      retryDelaySeconds: number;
      result: FailureNotificationDeliveryResultV1;
    }>,
  ): Promise<'completed' | 'stale'>;
  loadDestination(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      attemptNumber: number;
      workerId: string;
      signal: AbortSignal;
    }>,
  ): Promise<FailureNotificationResolvedDestination>;
  fenceDispatch(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      attemptNumber: number;
      deliveryBinding?: string;
    }>,
  ): Promise<void>;
  recoverDue(limit: number, maxAttempts: number): Promise<number>;
  close(): Promise<void>;
}

export function createFailureNotificationStore(
  config: DatabaseConfig,
): FailureNotificationStore {
  const pool = createDatabasePool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
  });
  pool.on('error', () => undefined);
  return Object.freeze({
    claimDelivery: async (
      raw: Parameters<FailureNotificationStore['claimDelivery']>[0],
    ) => {
      const workspaceId = identitySchema.parse(raw.workspaceId);
      const intentId = identitySchema.parse(raw.intentId);
      const delivery = {
        outboxEventId: identitySchema.parse(raw.delivery.outboxEventId),
        payloadChecksum: checksumSchema.parse(raw.delivery.payloadChecksum),
      };
      if (
        !Number.isSafeInteger(raw.maxAttempts) ||
        raw.maxAttempts < 1 ||
        raw.maxAttempts > 10
      )
        throw new FailureNotificationStateError('Invalid maximum attempts');
      if (
        !Number.isSafeInteger(raw.recoverySeconds) ||
        raw.recoverySeconds < 1 ||
        raw.recoverySeconds > 3600
      )
        throw new FailureNotificationStateError('Invalid recovery timeout');
      return withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const authoritative = await client.query<{
          aggregate_id: string;
          aggregate_type: string;
          job_name: string;
          payload: unknown;
          payload_checksum: string;
          schema_version: number;
        }>(
          `select aggregate_id,aggregate_type,job_name,payload,payload_checksum,schema_version
           from app.outbox_events where workspace_id=$1 and id=$2`,
          [workspaceId, delivery.outboxEventId],
        );
        const outbox = authoritative.rows[0];
        const actualChecksum =
          outbox === undefined
            ? undefined
            : createHash('sha256')
                .update(serializeStoredExecutionJsonValue(outbox.payload))
                .digest('hex');
        if (
          outbox?.aggregate_id !== intentId ||
          outbox.aggregate_type !== 'run-failure-notification' ||
          outbox.job_name !== 'deliver-run-failure-notification' ||
          outbox.schema_version !== 1 ||
          outbox.payload_checksum !== delivery.payloadChecksum ||
          actualChecksum !== delivery.payloadChecksum
        )
          throw new FailureNotificationStateError('Delivery identity mismatch');
        const result = await client.query<{
          context: unknown;
          context_checksum: string;
          delivery_attempts: number;
          destination_config_version: number;
          destination_id: string;
          recovery_at: Date | null;
          next_delivery_at: Date | null;
          retry_due: boolean;
          side_effect_class: 'safe' | 'idempotent_with_key' | 'unsafe';
          connection_secret_version_id: string | null;
          delivery_binding: string | null;
          possibly_dispatched: boolean | null;
          status: string;
        }>(
          `select context,context_checksum,delivery_attempts,destination_id,
                   destination_config_version,side_effect_class,status,recovery_at,next_delivery_at,
                    connection_secret_version_id,delivery_binding,possibly_dispatched,
                  (next_delivery_at is not null and next_delivery_at<=clock_timestamp()) retry_due
           from app.run_failure_notification_intents
           where workspace_id=$1 and id=$2 for update`,
          [workspaceId, intentId],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new FailureNotificationStateError('Intent not found');
        if (
          ['delivered', 'dead_letter', 'outcome_unknown'].includes(row.status)
        )
          return Object.freeze({ kind: 'terminal' as const });
        if (row.status === 'claimed' || row.status === 'dispatching')
          return Object.freeze({ kind: 'busy' as const });
        if (
          row.status === 'retry' &&
          (row.next_delivery_at === null || !row.retry_due)
        )
          return Object.freeze({ kind: 'busy' as const });
        if (row.delivery_attempts >= raw.maxAttempts) {
          const unresolved =
            row.side_effect_class === 'idempotent_with_key' &&
            row.possibly_dispatched === true;
          const terminalStatus = unresolved ? 'outcome_unknown' : 'dead_letter';
          const safeErrorCode = unresolved
            ? 'delivery.attempts_exhausted_unknown'
            : 'delivery.attempts_exhausted';
          await client.query(
            `update app.run_failure_notification_intents
             set status=$3,dispatch_marked_at=null,recovery_at=null,
                  next_delivery_at=null,safe_error_code=$4,
                  possibly_dispatched=$5,completed_at=clock_timestamp(),updated_at=clock_timestamp()
              where workspace_id=$1 and id=$2`,
            [workspaceId, intentId, terminalStatus, safeErrorCode, unresolved],
          );
          await audit(client, {
            workspaceId,
            intentId,
            factType: unresolved ? 'outcome_unknown' : 'dead_lettered',
            attemptNumber: row.delivery_attempts,
            safeErrorCode,
            possiblyDispatched: unresolved,
          });
          return Object.freeze({ kind: 'terminal' as const });
        }
        if (
          (row.status !== 'pending' && row.status !== 'retry') ||
          (row.status === 'pending' && row.delivery_attempts !== 0)
        )
          throw new FailureNotificationStateError(
            'Intent lifecycle is corrupt',
          );
        const context = FailureNotificationContextV1Schema.parse(row.context);
        const checksum = createHash('sha256')
          .update(serializeStoredExecutionJsonValue(context))
          .digest('hex');
        if (checksum !== row.context_checksum)
          throw new FailureNotificationStateError('Intent checksum mismatch');
        const attemptNumber = row.delivery_attempts + 1;
        const connectionSecretVersionId = identitySchema.parse(
          row.connection_secret_version_id,
        );
        const marked = await client.query(
          `update app.run_failure_notification_intents
           set status='claimed',delivery_attempts=$3,
                dispatch_marked_at=null,
               recovery_at=clock_timestamp()+make_interval(secs=>$4),
               next_delivery_at=null,updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2 and status=$5`,
          [
            workspaceId,
            intentId,
            attemptNumber,
            raw.recoverySeconds,
            row.status,
          ],
        );
        if (marked.rowCount !== 1)
          return Object.freeze({ kind: 'busy' as const });
        return Object.freeze({
          kind: 'ready' as const,
          attemptNumber,
          context,
          destinationId: row.destination_id,
          destinationConfigVersion: row.destination_config_version,
          sideEffectClass: row.side_effect_class,
          idempotencyKey: `failure-notification:v1:${intentId}`,
          connectionSecretVersionId,
          deliveryUnresolved: row.possibly_dispatched === true,
          ...(row.delivery_binding === null
            ? {}
            : {
                deliveryBinding: z
                  .string()
                  .regex(/^email:v1:sha256:[0-9a-f]{64}$/u)
                  .parse(row.delivery_binding),
              }),
        });
      });
    },
    ...createFailureNotificationDestinationStore(pool),
    ...createFailureNotificationCompletionStore(pool),
    recoverDue: async (limit: number, maxAttempts: number) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new FailureNotificationStateError('Invalid recovery limit');
      if (
        !Number.isSafeInteger(maxAttempts) ||
        maxAttempts < 1 ||
        maxAttempts > 10
      )
        throw new FailureNotificationStateError('Invalid maximum attempts');
      const result = await pool.query<{ recovered: number }>(
        'select app.recover_due_run_failure_notifications($1,$2) as recovered',
        [limit, maxAttempts],
      );
      return result.rows[0]?.recovered ?? 0;
    },
    close: async () => pool.end(),
  });
}
