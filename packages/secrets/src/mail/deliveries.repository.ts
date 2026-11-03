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
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { systemMailDeliveries } from '@pertexo/database/schema';
import { compareClaims } from './claim-order.js';
import type {
  SystemMailClaimRequest,
  SystemMailDeliveryClaim,
  SystemMailInput,
  SystemMailSettlement,
} from './contract.js';

// Twelve attempts within 24 hours, before link expiry, under a 60-second lease. The
// table's system_mail_attempts_bounded check holds the same twelve.
const MAX_ATTEMPTS = 12;
const DELIVERY_WINDOW = sql.raw("interval '24 hours'");
const LEASE = sql.raw("interval '60 seconds'");
// What the provider_reference and failure_code columns hold.
const PROVIDER_REFERENCE_LENGTH = 512;
const FAILURE_CODE_LENGTH = 128;

/** Queues one sealed system mail in the caller's transaction. */
export async function insertSystemMail(
  client: Pool | PoolClient,
  input: SystemMailInput,
): Promise<void> {
  const sealed = input.sealedPayload;
  await drizzle(client).insert(systemMailDeliveries).values({
    id: input.id,
    purpose: input.purpose,
    expiresAt: input.expiresAt.toISOString(),
    payloadCiphertext: sealed.ciphertext,
    payloadNonce: sealed.nonce,
    payloadTag: sealed.tag,
    payloadKeyVersion: sealed.keyVersion,
  });
}

export async function claimMail(
  pool: Pool,
  input: SystemMailClaimRequest,
): Promise<readonly SystemMailDeliveryClaim[]> {
  const workerId = input.workerId;
  const limit = input.limit;
  const leaseToken = randomUUID();
  const db = drizzle(pool);
  const delivery = systemMailDeliveries;
  const candidates = db.$with('candidates').as(
    db
      .select({ id: delivery.id, status: delivery.status })
      .from(delivery)
      .where(
        and(
          inArray(delivery.status, ['queued', 'outcome_unknown', 'retry']),
          gt(delivery.expiresAt, sql`clock_timestamp()`),
          sql`${delivery.createdAt}+${DELIVERY_WINDOW}>clock_timestamp()`,
          lte(delivery.nextAttemptAt, sql`clock_timestamp()`),
          or(
            isNull(delivery.leaseExpiresAt),
            lte(delivery.leaseExpiresAt, sql`clock_timestamp()`),
          ),
          lt(delivery.attemptCount, MAX_ATTEMPTS),
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
      leaseExpiresAt: sql`clock_timestamp()+${LEASE}`,
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
  rows.sort(compareClaims);
  return Object.freeze(
    rows.map(({ nextAttemptAt, ...claim }) => Object.freeze(claim)),
  );
}

export async function settleMail(
  pool: Pool,
  input: SystemMailSettlement,
): Promise<boolean> {
  const id = input.id,
    leaseToken = input.leaseToken;
  const leaseGeneration = input.leaseGeneration;
  const outcome = input.outcome;
  const retryAt = input.retryAt ?? null;
  const db = drizzle(pool);
  const delivery = systemMailDeliveries;
  // Preserve the retry decision's statement snapshot while the target row waits for a lock.
  const retry = db
    .select({
      id: delivery.id,
      allowed:
        sql<boolean>`${outcome}='retry' and ${delivery.attemptCount}<${MAX_ATTEMPTS} and ${retryAt}::timestamptz<${delivery.expiresAt} and ${retryAt}::timestamptz<${delivery.createdAt}+${DELIVERY_WINDOW}`.as(
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
      providerReference: sql`left(${input.providerReference ?? null}::text,${PROVIDER_REFERENCE_LENGTH})`,
      failureCode: sql`left(${input.failureCode ?? null}::text,${FAILURE_CODE_LENGTH})`,
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
