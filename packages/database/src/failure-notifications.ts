import { createHash } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import {
  FailureNotificationContextV1Schema,
  FailureNotificationDeliveryResultV1Schema,
  type FailureNotificationContextV1,
  type FailureNotificationDeliveryResultV1,
} from '@pertexo/workflow-model/failure-notification';

import type { DatabaseConfig } from './config.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

const identitySchema = z.uuid();
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/u);

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
    }>;

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
  recoverDue(limit: number): Promise<number>;
  close(): Promise<void>;
}

export class FailureNotificationStateError extends Error {
  public override readonly name = 'FailureNotificationStateError';
}

async function transaction<T>(
  pool: Pool,
  workspaceId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function retryOutboxId(intentId: string, attemptNumber: number): string {
  return uuidv5(`delivery:${String(attemptNumber)}`, intentId);
}

async function insertDeliveryOutbox(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    intentId: string;
    attemptNumber: number;
    availableAt: Date;
  }>,
): Promise<void> {
  const outboxEventId = retryOutboxId(input.intentId, input.attemptNumber);
  const payload = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    notificationIntentId: input.intentId,
    outboxEventId,
  } as const;
  await client.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
       payload,payload_checksum,available_at
     ) values ($1,$2,'deliver-run-failure-notification',1,
       'run-failure-notification',$3,$4::jsonb,$5,$6)
     on conflict (id) do nothing`,
    [
      outboxEventId,
      input.workspaceId,
      input.intentId,
      serializeStoredExecutionJsonValue(payload),
      canonicalOutboxPayloadChecksum(payload),
      input.availableAt,
    ],
  );
}

async function audit(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    intentId: string;
    factType: string;
    attemptNumber: number;
    safeErrorCode?: string;
    possiblyDispatched: boolean;
  }>,
): Promise<void> {
  await client.query(
    `insert into app.run_failure_notification_audit_facts (
       id,workspace_id,notification_intent_id,fact_type,attempt_number,
       safe_error_code,possibly_dispatched
     ) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
    [
      input.workspaceId,
      input.intentId,
      input.factType,
      input.attemptNumber,
      input.safeErrorCode ?? null,
      input.possiblyDispatched,
    ],
  );
}

export function createFailureNotificationStore(
  config: DatabaseConfig,
): FailureNotificationStore {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
  });
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
      return transaction(pool, workspaceId, async (client) => {
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
          status: string;
        }>(
          `select context,context_checksum,delivery_attempts,destination_id,
                  destination_config_version,side_effect_class,status,recovery_at,next_delivery_at,
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
        if (row.status === 'dispatching')
          return Object.freeze({ kind: 'busy' as const });
        if (
          row.status === 'retry' &&
          (row.next_delivery_at === null || !row.retry_due)
        )
          return Object.freeze({ kind: 'busy' as const });
        if (row.delivery_attempts >= raw.maxAttempts) {
          await client.query(
            `update app.run_failure_notification_intents
             set status='dead_letter',dispatch_marked_at=null,recovery_at=null,
                 next_delivery_at=null,safe_error_code='delivery.attempts_exhausted',
                 possibly_dispatched=false,completed_at=clock_timestamp(),updated_at=clock_timestamp()
             where workspace_id=$1 and id=$2`,
            [workspaceId, intentId],
          );
          await audit(client, {
            workspaceId,
            intentId,
            factType: 'dead_lettered',
            attemptNumber: row.delivery_attempts,
            safeErrorCode: 'delivery.attempts_exhausted',
            possiblyDispatched: false,
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
        const marked = await client.query(
          `update app.run_failure_notification_intents
           set status='dispatching',delivery_attempts=$3,
               dispatch_marked_at=clock_timestamp(),
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
        await audit(client, {
          workspaceId,
          intentId,
          factType: 'dispatch_marked',
          attemptNumber,
          possiblyDispatched: false,
        });
        return Object.freeze({
          kind: 'ready' as const,
          attemptNumber,
          context,
          destinationId: row.destination_id,
          destinationConfigVersion: row.destination_config_version,
          sideEffectClass: row.side_effect_class,
          idempotencyKey: `failure-notification:v1:${intentId}`,
        });
      });
    },
    completeDelivery: async (
      raw: Parameters<FailureNotificationStore['completeDelivery']>[0],
    ) => {
      const workspaceId = identitySchema.parse(raw.workspaceId);
      const intentId = identitySchema.parse(raw.intentId);
      const result = FailureNotificationDeliveryResultV1Schema.parse(
        raw.result,
      );
      return transaction(pool, workspaceId, async (client) => {
        const locked = await client.query<{
          delivery_attempts: number;
          side_effect_class: 'safe' | 'idempotent_with_key' | 'unsafe';
          status: string;
        }>(
          `select status,delivery_attempts,side_effect_class
           from app.run_failure_notification_intents
           where workspace_id=$1 and id=$2 for update`,
          [workspaceId, intentId],
        );
        const row = locked.rows[0];
        if (
          row?.status !== 'dispatching' ||
          row.delivery_attempts !== raw.attemptNumber
        )
          return 'stale' as const;
        const mayRetry =
          row.side_effect_class !== 'unsafe' &&
          raw.attemptNumber < raw.maxAttempts &&
          (result.kind === 'retry' || result.kind === 'outcome_unknown');
        if (mayRetry) {
          const scheduled = await client.query<{ next_delivery_at: Date }>(
            `update app.run_failure_notification_intents
             set status='retry',dispatch_marked_at=null,recovery_at=null,
                  next_delivery_at=clock_timestamp()+make_interval(secs=>$3),
                  safe_error_code=$4,possibly_dispatched=$5,updated_at=clock_timestamp()
             where workspace_id=$1 and id=$2
             returning next_delivery_at`,
            [
              workspaceId,
              intentId,
              raw.retryDelaySeconds,
              result.safeErrorCode ?? null,
              result.possiblyDispatched,
            ],
          );
          const due = scheduled.rows[0]?.next_delivery_at;
          if (due === undefined)
            throw new FailureNotificationStateError(
              'Retry schedule was not persisted',
            );
          await insertDeliveryOutbox(client, {
            workspaceId,
            intentId,
            attemptNumber: raw.attemptNumber + 1,
            availableAt: due,
          });
          await audit(client, {
            workspaceId,
            intentId,
            factType: 'retry_scheduled',
            attemptNumber: raw.attemptNumber,
            ...(result.safeErrorCode === undefined
              ? {}
              : { safeErrorCode: result.safeErrorCode }),
            possiblyDispatched: result.possiblyDispatched,
          });
          return 'completed' as const;
        }
        const terminalStatus =
          result.kind === 'delivered'
            ? 'delivered'
            : result.kind === 'outcome_unknown'
              ? 'outcome_unknown'
              : 'dead_letter';
        await client.query(
          `update app.run_failure_notification_intents
           set status=$3,dispatch_marked_at=null,recovery_at=null,next_delivery_at=null,
               safe_error_code=$4,possibly_dispatched=$5,provider_reference=$6,
               completed_at=clock_timestamp(),updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2`,
          [
            workspaceId,
            intentId,
            terminalStatus,
            result.safeErrorCode ?? null,
            result.possiblyDispatched,
            result.providerReference ?? null,
          ],
        );
        await audit(client, {
          workspaceId,
          intentId,
          factType:
            terminalStatus === 'delivered'
              ? 'delivered'
              : terminalStatus === 'outcome_unknown'
                ? 'outcome_unknown'
                : 'dead_lettered',
          attemptNumber: raw.attemptNumber,
          ...(result.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: result.safeErrorCode }),
          possiblyDispatched: result.possiblyDispatched,
        });
        return 'completed' as const;
      });
    },
    recoverDue: async (limit: number) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new FailureNotificationStateError('Invalid recovery limit');
      const result = await pool.query<{ recovered: number }>(
        'select app.recover_due_run_failure_notifications($1) as recovered',
        [limit],
      );
      return result.rows[0]?.recovered ?? 0;
    },
    close: async () => pool.end(),
  });
}
