import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { rethrowQueryFailure } from '../query-errors.js';
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
    claim: (input: Parameters<SystemMailDeliveryStore['claim']>[0]) =>
      claimMail(lease.pool, input),
    settle: (input: Parameters<SystemMailDeliveryStore['settle']>[0]) =>
      settleMail(lease.pool, input),
    close: () => lease.close(),
  });
}

async function claimMail(
  pool: Pool,
  input: Parameters<SystemMailDeliveryStore['claim']>[0],
): Promise<readonly SystemMailDeliveryClaim[]> {
  const workerId = z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
    .parse(input.workerId);
  const limit = z.number().int().min(1).max(50).parse(input.limit);
  const leaseToken = randomUUID();
  const db = drizzle(pool);
  const delivery = systemMailDeliveries;
  // Twelve attempts within 24 hours, before link expiry, under a 60-second lease.
  const candidates = db.$with('candidates').as(
    db
      .select({ id: delivery.id, status: delivery.status })
      .from(delivery)
      .where(
        and(
          inArray(delivery.status, ['queued', 'outcome_unknown', 'retry']),
          gt(delivery.expiresAt, sql`clock_timestamp()`),
          sql`${delivery.createdAt}+interval '24 hours'>clock_timestamp()`,
          lte(delivery.nextAttemptAt, sql`clock_timestamp()`),
          or(
            isNull(delivery.leaseExpiresAt),
            lte(delivery.leaseExpiresAt, sql`clock_timestamp()`),
          ),
          lt(delivery.attemptCount, 12),
        ),
      )
      .orderBy(
        asc(sql`${delivery.purpose}='workspace_notice'`),
        asc(delivery.nextAttemptAt),
        asc(delivery.id),
      )
      .limit(limit)
      .for('update', { skipLocked: true }),
  );
  const rows = await db
    .with(candidates)
    .update(delivery)
    .set({
      status: 'outcome_unknown',
      leaseOwner: workerId,
      leaseToken,
      leaseGeneration: sql`${delivery.leaseGeneration}+1`,
      leaseExpiresAt: sql`clock_timestamp()+interval '60 seconds'`,
      attemptCount: sql`${delivery.attemptCount}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(candidates)
    .where(eq(delivery.id, candidates.id))
    .returning({
      id: delivery.id,
      purpose: delivery.purpose,
      expiresAt: sql<string>`${delivery.expiresAt}`.mapWith(
        (value: string) => new Date(value),
      ),
      attemptCount: delivery.attemptCount,
      leaseGeneration: delivery.leaseGeneration,
      leaseToken: sql<string>`${delivery.leaseToken}`,
      recoveredUnknown: sql<boolean>`${candidates.status}='outcome_unknown'`,
      sealedPayload: {
        ciphertext: sql<string>`${delivery.payloadCiphertext}`,
        nonce: sql<string>`${delivery.payloadNonce}`,
        tag: sql<string>`${delivery.payloadTag}`,
        keyVersion: sql<string>`${delivery.payloadKeyVersion}`,
      },
      nextAttemptAt: sql<string>`${delivery.nextAttemptAt}`.mapWith(
        (value: string) => new Date(value),
      ),
    })
    .catch(rethrowQueryFailure);
  rows.sort(
    (left, right) =>
      Number(left.purpose === 'workspace_notice') -
        Number(right.purpose === 'workspace_notice') ||
      left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() ||
      left.id.localeCompare(right.id),
  );
  return Object.freeze(
    rows.map(({ nextAttemptAt, ...claim }) => Object.freeze(claim)),
  );
}

async function settleMail(
  pool: Pool,
  input: Parameters<SystemMailDeliveryStore['settle']>[0],
): Promise<boolean> {
  if (input.outcome === 'retry' && input.retryAt === undefined)
    throw new TypeError('A retry needs its next attempt time');
  const id = z.uuid().parse(input.id),
    leaseToken = z.uuid().parse(input.leaseToken);
  const leaseGeneration = z
    .number()
    .int()
    .positive()
    .parse(input.leaseGeneration);
  const outcome = z
    .enum(['submitted', 'failed', 'retry', 'reconciliation_required'])
    .parse(input.outcome);
  const retryAt = input.retryAt ?? null;
  const db = drizzle(pool);
  const delivery = systemMailDeliveries;
  // Preserve the retry decision's statement snapshot while the target row waits for a lock.
  const retry = db
    .select({
      id: delivery.id,
      allowed:
        sql<boolean>`${outcome}='retry' and ${delivery.attemptCount}<12 and ${retryAt}::timestamptz<${delivery.expiresAt} and ${retryAt}::timestamptz<${delivery.createdAt}+interval '24 hours'`.as(
          'allowed',
        ),
    })
    .from(delivery)
    .where(eq(delivery.id, id))
    .as('retry');
  const updated = await db
    .update(delivery)
    .set({
      status: sql`case when ${outcome}<>'retry' then ${outcome} when ${retry.allowed} then 'retry' else 'reconciliation_required' end`,
      nextAttemptAt: sql`case when ${outcome}='retry' then ${retryAt}::timestamptz else ${delivery.nextAttemptAt} end`,
      providerReference: sql`left(${input.providerReference ?? null}::text,512)`,
      failureCode: sql`left(${input.failureCode ?? null}::text,128)`,
      payloadCiphertext: sql`case when ${retry.allowed} then ${delivery.payloadCiphertext} end`,
      payloadNonce: sql`case when ${retry.allowed} then ${delivery.payloadNonce} end`,
      payloadTag: sql`case when ${retry.allowed} then ${delivery.payloadTag} end`,
      payloadKeyVersion: sql`case when ${retry.allowed} then ${delivery.payloadKeyVersion} end`,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: sql`case when ${retry.allowed} then null else clock_timestamp() end`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(retry)
    .where(
      and(
        eq(delivery.id, retry.id),
        eq(delivery.status, 'outcome_unknown'),
        eq(delivery.leaseToken, leaseToken),
        eq(delivery.leaseGeneration, leaseGeneration),
      ),
    )
    .returning({ id: delivery.id })
    .catch(rethrowQueryFailure);
  return updated.length === 1;
}
