import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { systemMailDeliveries } from '../../schema/mail/deliveries.js';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import { acquireDatabasePool, type DatabaseRuntime } from '../pool/runtime.js';

const purpose = z.enum([
  'workspace_notice',
  'two_factor_disabled',
  'recovery_code_sign_in',
  'verification',
  'password_reset',
  'email_change_confirmation',
]);
const sealedPayload = z
  .object({
    ciphertext: z.string().min(1).max(32_768),
    nonce: z.string().min(1).max(128),
    tag: z.string().min(1).max(256),
    keyVersion: z.string().min(1).max(64),
  })
  .strict();

export type SystemMailPurpose = z.infer<typeof purpose>;
export type SealedSystemMailPayload = z.infer<typeof sealedPayload>;

export interface SystemMailEnqueueStore {
  enqueue(input: SystemMailInput): Promise<void>;
  close(): Promise<void>;
}

export type SystemMailDeliveryClaim = Readonly<{
  id: string;
  purpose: SystemMailPurpose;
  expiresAt: Date;
  attemptCount: number;
  recoveredUnknown: boolean;
  leaseGeneration: number;
  leaseToken: string;
  sealedPayload: SealedSystemMailPayload;
}>;

export interface SystemMailDeliveryStore {
  claim(
    input: Readonly<{ workerId: string; limit: number }>,
  ): Promise<readonly SystemMailDeliveryClaim[]>;
  settle(
    input: Readonly<{
      id: string;
      leaseToken: string;
      leaseGeneration: number;
      outcome: 'submitted' | 'failed' | 'retry' | 'reconciliation_required';
      providerReference?: string;
      failureCode?: string;
      retryAt?: Date;
    }>,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export type SystemMailInput = Readonly<{
  id: string;
  purpose: SystemMailPurpose;
  expiresAt: Date;
  sealedPayload: SealedSystemMailPayload;
}>;

/** Queues one sealed system mail in the caller's transaction. */
export async function insertSystemMail(
  client: Pool | PoolClient,
  input: SystemMailInput,
): Promise<void> {
  const sealed = sealedPayload.parse(input.sealedPayload);
  await drizzle(client)
    .insert(systemMailDeliveries)
    .values({
      id: z.uuid().parse(input.id),
      purpose: purpose.parse(input.purpose),
      expiresAt: z.date().parse(input.expiresAt).toISOString(),
      payloadCiphertext: sealed.ciphertext,
      payloadNonce: sealed.nonce,
      payloadTag: sealed.tag,
      payloadKeyVersion: sealed.keyVersion,
    });
}

export function createSystemMailEnqueueStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): SystemMailEnqueueStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'api' });
  return Object.freeze({
    enqueue: (input: SystemMailInput) => insertSystemMail(lease.pool, input),
    close: () => lease.close(),
  });
}

export function createSystemMailDeliveryStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): SystemMailDeliveryStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });
  return Object.freeze({
    claim: async (input: Parameters<SystemMailDeliveryStore['claim']>[0]) => {
      const leaseToken = randomUUID();
      const result = await lease.pool.query<{
        id: string;
        recovered_unknown: boolean;
        purpose: string;
        expires_at: Date;
        attempt_count: number;
        lease_generation: string;
        payload_ciphertext: string;
        payload_nonce: string;
        payload_tag: string;
        payload_key_version: string;
        next_attempt_at: Date;
      }>(
        // A delivery is tried at most 12 times within 24 hours and before
        // its link expires; a claim holds it for 60 seconds.
        `with candidates as (
           select id, status from app.system_mail_deliveries
           where status in ('queued', 'outcome_unknown', 'retry')
             and expires_at > clock_timestamp()
             and created_at + interval '24 hours' > clock_timestamp()
             and next_attempt_at <= clock_timestamp()
             and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
             and attempt_count < 12
           order by (purpose='workspace_notice'),next_attempt_at,id
           limit $2
           for update skip locked
         )
         update app.system_mail_deliveries delivery
         set status = 'outcome_unknown', lease_owner = $1, lease_token = $3,
             lease_generation = delivery.lease_generation + 1,
             lease_expires_at = clock_timestamp() + interval '60 seconds',
             attempt_count = delivery.attempt_count + 1,
             updated_at = clock_timestamp()
         from candidates where delivery.id = candidates.id
         returning delivery.id, delivery.purpose, delivery.expires_at,
           delivery.attempt_count, delivery.lease_generation,
           delivery.payload_ciphertext, delivery.payload_nonce,
           delivery.payload_tag, delivery.payload_key_version,
           delivery.next_attempt_at, candidates.status = 'outcome_unknown' recovered_unknown`,
        [
          z
            .string()
            .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
            .parse(input.workerId),
          z.number().int().min(1).max(50).parse(input.limit),
          leaseToken,
        ],
      );
      const claimed = [...result.rows].sort(
        (left, right) =>
          Number(left.purpose === 'workspace_notice') -
            Number(right.purpose === 'workspace_notice') ||
          left.next_attempt_at.getTime() - right.next_attempt_at.getTime() ||
          left.id.localeCompare(right.id),
      );
      return Object.freeze(
        claimed.map((row) =>
          Object.freeze({
            id: z.uuid().parse(row.id),
            purpose: purpose.parse(row.purpose),
            expiresAt: z.coerce.date().parse(row.expires_at),
            attemptCount: z
              .number()
              .int()
              .positive()
              .max(12)
              .parse(row.attempt_count),
            leaseGeneration: z.coerce
              .number()
              .int()
              .positive()
              .parse(row.lease_generation),
            leaseToken,
            recoveredUnknown: row.recovered_unknown,
            sealedPayload: sealedPayload.parse({
              ciphertext: row.payload_ciphertext,
              nonce: row.payload_nonce,
              tag: row.payload_tag,
              keyVersion: row.payload_key_version,
            }),
          }),
        ),
      );
    },
    settle: async (input: Parameters<SystemMailDeliveryStore['settle']>[0]) => {
      if (input.outcome === 'retry' && input.retryAt === undefined)
        throw new TypeError('A retry needs its next attempt time');
      // A retry keeps its sealed payload only while another attempt is still
      // allowed; otherwise the delivery needs reconciliation.
      const result = await lease.pool.query(
        `update app.system_mail_deliveries delivery
         set status = case when $4 <> 'retry' then $4
                           when retry.allowed then 'retry'
                           else 'reconciliation_required' end,
             next_attempt_at = case when $4 = 'retry' then $7
                                    else delivery.next_attempt_at end,
             provider_reference = left($5, 512),
             failure_code = left($6, 128),
             payload_ciphertext = case when retry.allowed then delivery.payload_ciphertext end,
             payload_nonce = case when retry.allowed then delivery.payload_nonce end,
             payload_tag = case when retry.allowed then delivery.payload_tag end,
             payload_key_version = case when retry.allowed then delivery.payload_key_version end,
             lease_owner = null, lease_token = null, lease_expires_at = null,
             completed_at = case when retry.allowed then null else clock_timestamp() end,
             updated_at = clock_timestamp()
         from (
           select id, $4 = 'retry' and attempt_count < 12
               and $7::timestamptz < expires_at
               and $7::timestamptz < created_at + interval '24 hours' allowed
           from app.system_mail_deliveries where id = $1
         ) retry
         where delivery.id = retry.id and delivery.status = 'outcome_unknown'
           and delivery.lease_token = $2 and delivery.lease_generation = $3`,
        [
          z.uuid().parse(input.id),
          z.uuid().parse(input.leaseToken),
          z.number().int().positive().parse(input.leaseGeneration),
          z
            .enum(['submitted', 'failed', 'retry', 'reconciliation_required'])
            .parse(input.outcome),
          input.providerReference ?? null,
          input.failureCode ?? null,
          input.retryAt ?? null,
        ],
      );
      return result.rowCount === 1;
    },
    close: () => lease.close(),
  });
}
