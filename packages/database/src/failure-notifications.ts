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
      connectionSecretVersionId: string;
      deliveryBinding?: string;
      deliveryUnresolved: boolean;
    }>;

export type FailureNotificationDestination = Readonly<{
  kind: 'slack' | 'email';
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
  target: string;
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
  loadDestination(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      attemptNumber: number;
      workerId: string;
      signal: AbortSignal;
    }>,
  ): Promise<FailureNotificationDestination>;
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

export class FailureNotificationStateError extends Error {
  public override readonly name = 'FailureNotificationStateError';
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
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

async function abortableTransaction<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const abortError = new Error('Failure notification transaction aborted');
  abortError.name = 'AbortError';
  if (isAborted(signal)) throw abortError;
  const client = await pool.connect();
  const connectionState = { released: false };
  const releaseForAbort = (): void => {
    if (connectionState.released) return;
    connectionState.released = true;
    client.release(abortError);
  };
  signal.addEventListener('abort', releaseForAbort, { once: true });
  try {
    if (isAborted(signal)) throw abortError;
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query("select set_config('statement_timeout','30000',true)");
    const result = await operation(client);
    if (isAborted(signal)) throw abortError;
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    if (isAborted(signal)) throw abortError;
    if (!connectionState.released)
      await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', releaseForAbort);
    if (!connectionState.released) {
      connectionState.released = true;
      client.release();
    }
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
    loadDestination: async (
      raw: Parameters<FailureNotificationStore['loadDestination']>[0],
    ) => {
      const workspaceId = identitySchema.parse(raw.workspaceId);
      const intentId = identitySchema.parse(raw.intentId);
      const workerId = z.string().min(1).max(128).parse(raw.workerId);
      return abortableTransaction(
        pool,
        workspaceId,
        raw.signal,
        async (client) => {
          const result = await client.query<Record<string, unknown>>(
            `select version.kind, version.config, intent.connection_secret_version_id,
                  secret.schema_version, secret.kms_key_reference,
                  secret.encrypted_data_key, secret.ciphertext, secret.nonce,
                  secret.auth_tag
             from app.run_failure_notification_intents intent
             join app.failure_notification_destinations destination
               on destination.workspace_id=intent.workspace_id
              and destination.id=intent.destination_id
             join app.failure_notification_destination_versions version
               on version.workspace_id=intent.workspace_id
              and version.destination_id=intent.destination_id
              and version.version=intent.destination_config_version
             join app.connections connection
               on connection.workspace_id=intent.workspace_id
              and connection.id=(version.config->>'connectionId')::uuid
             join app.connection_secret_versions secret
               on secret.workspace_id=connection.workspace_id
              and secret.connection_id=connection.id
              and secret.id=intent.connection_secret_version_id
              where intent.workspace_id=$1 and intent.id=$2
                and intent.status='claimed' and intent.delivery_attempts=$3
                and destination.status='enabled'
                and destination.kind=version.kind
               and version.side_effect_class=intent.side_effect_class
               and connection.provider_key=version.kind
               and connection.auth_type=case version.kind
                 when 'slack' then 'slack_bot_token' else 'resend_api_key' end
               and connection.status='active'
              and connection.current_secret_version_id=intent.connection_secret_version_id`,
            [workspaceId, intentId, raw.attemptNumber],
          );
          const row = result.rows[0];
          if (row === undefined)
            throw new FailureNotificationStateError(
              'Delivery destination is unavailable',
            );
          const config = z.record(z.string(), z.unknown()).parse(row.config);
          const kind = z.enum(['slack', 'email']).parse(row.kind);
          const connectionId = identitySchema.parse(config.connectionId);
          const target = z
            .string()
            .min(1)
            .max(254)
            .parse(kind === 'slack' ? config.channelId : config.toEmail);
          const secretVersionId = identitySchema.parse(
            row.connection_secret_version_id,
          );
          await client.query(
            `insert into app.connection_events
             (id,workspace_id,connection_id,event_type,actor_kind,actor_id,metadata)
           values (gen_random_uuid(),$1,$2,'connection.credential_accessed','worker',$3,$4::jsonb)`,
            [
              workspaceId,
              connectionId,
              workerId,
              JSON.stringify({
                purpose: 'failure_notification.deliver',
                secretVersionId,
              }),
            ],
          );
          return Object.freeze({
            kind,
            connectionId,
            secretVersionId,
            target,
            sealed: Object.freeze({
              schemaVersion: z.literal(1).parse(row.schema_version),
              kmsKeyReference: z.string().parse(row.kms_key_reference),
              encryptedDataKey: z.string().parse(row.encrypted_data_key),
              ciphertext: z.string().parse(row.ciphertext),
              nonce: z.string().parse(row.nonce),
              tag: z.string().parse(row.auth_tag),
            }),
          });
        },
      );
    },
    fenceDispatch: async (
      raw: Parameters<FailureNotificationStore['fenceDispatch']>[0],
    ) => {
      const workspaceId = identitySchema.parse(raw.workspaceId);
      const intentId = identitySchema.parse(raw.intentId);
      const binding = raw.deliveryBinding;
      await transaction(pool, workspaceId, async (client) => {
        const parsedBinding =
          binding === undefined
            ? null
            : z
                .string()
                .regex(/^email:v1:sha256:[0-9a-f]{64}$/u)
                .parse(binding);
        const destination = await client.query<{ ready: boolean }>(
          `select app.lock_failure_notification_dispatch_destination($1,$2,$3) ready`,
          [workspaceId, intentId, raw.attemptNumber],
        );
        if (destination.rows[0]?.ready !== true)
          throw new FailureNotificationStateError(
            'Delivery dispatch fence failed',
          );
        const fenced = await client.query(
          `update app.run_failure_notification_intents intent
              set status='dispatching',dispatch_marked_at=clock_timestamp(),
                  delivery_binding=coalesce(intent.delivery_binding,$4),
                  updated_at=clock_timestamp()
             from app.failure_notification_destinations destination,
                  app.failure_notification_destination_versions version,
                  app.connections connection
            where intent.workspace_id=$1 and intent.id=$2
              and intent.status='claimed' and intent.delivery_attempts=$3
               and destination.workspace_id=intent.workspace_id
               and destination.id=intent.destination_id
               and destination.status='enabled'
               and destination.kind=version.kind
              and version.workspace_id=intent.workspace_id
              and version.destination_id=intent.destination_id
              and version.version=intent.destination_config_version
              and version.side_effect_class=intent.side_effect_class
              and connection.workspace_id=intent.workspace_id
              and connection.id=(version.config->>'connectionId')::uuid
              and connection.provider_key=version.kind
              and connection.auth_type=case version.kind
                when 'slack' then 'slack_bot_token' else 'resend_api_key' end
              and connection.status='active'
              and connection.current_secret_version_id=intent.connection_secret_version_id
              and (($4::text is null and intent.delivery_binding is null)
                or ($4 is not null and (intent.delivery_binding is null or intent.delivery_binding=$4)))
              and app.connection_dispatch_fence_current(
                intent.workspace_id,connection.id,version.kind,
                case version.kind when 'slack' then 'slack_bot_token' else 'resend_api_key' end,
                intent.connection_secret_version_id)
            returning intent.id`,
          [workspaceId, intentId, raw.attemptNumber, parsedBinding],
        );
        if (fenced.rowCount !== 1)
          throw new FailureNotificationStateError(
            'Delivery dispatch fence failed',
          );
        await audit(client, {
          workspaceId,
          intentId,
          factType: 'dispatch_marked',
          attemptNumber: raw.attemptNumber,
          possiblyDispatched: false,
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
          possibly_dispatched: boolean | null;
          side_effect_class: 'safe' | 'idempotent_with_key' | 'unsafe';
          status: string;
        }>(
          `select status,delivery_attempts,side_effect_class,possibly_dispatched
           from app.run_failure_notification_intents
           where workspace_id=$1 and id=$2 for update`,
          [workspaceId, intentId],
        );
        const row = locked.rows[0];
        if (
          (row?.status !== 'claimed' && row?.status !== 'dispatching') ||
          row.delivery_attempts !== raw.attemptNumber
        )
          return 'stale' as const;
        if (
          row.status === 'claimed' &&
          (result.kind === 'delivered' ||
            (result.kind === 'outcome_unknown' &&
              row.possibly_dispatched !== true))
        )
          throw new FailureNotificationStateError(
            'Predispatch completion result is incompatible',
          );
        const actuallyDispatched =
          row.status === 'dispatching' && result.possiblyDispatched;
        const deliveryUnresolved =
          row.possibly_dispatched === true || actuallyDispatched;
        const retryRequested =
          result.kind === 'retry' ||
          (row.side_effect_class !== 'unsafe' &&
            result.kind === 'outcome_unknown');
        const safeUnsafeRetry =
          row.side_effect_class !== 'unsafe' ||
          (result.kind === 'retry' && !actuallyDispatched);
        const mayRetry =
          retryRequested &&
          safeUnsafeRetry &&
          raw.attemptNumber < raw.maxAttempts;
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
              deliveryUnresolved,
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
            possiblyDispatched: deliveryUnresolved,
          });
          return 'completed' as const;
        }
        const terminalStatus =
          result.kind === 'delivered'
            ? 'delivered'
            : actuallyDispatched ||
                result.kind === 'outcome_unknown' ||
                (row.side_effect_class === 'idempotent_with_key' &&
                  deliveryUnresolved)
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
            deliveryUnresolved,
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
          possiblyDispatched: deliveryUnresolved,
        });
        return 'completed' as const;
      });
    },
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
