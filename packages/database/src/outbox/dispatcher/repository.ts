import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { outboxEvents } from '../../schema/transport.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import type { DatabaseConfig } from '../../config.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { checkDatabaseReadiness } from '../../platform/readiness.queries.js';
import { claimOutboxBatch } from './claim.repository.js';
import type { ClaimOutboxBatchInput } from './contract.js';
import type { ReleaseInput } from './input.js';
import type {
  OutboxDispatcherDatabase,
  ObserveOutboxBacklogInput,
  ReleaseOutboxResult,
} from './contract.js';
import { observeOutboxBacklog } from './backlog.queries.js';

function currentLease(id: string, leaseToken: string) {
  return and(
    eq(outboxEvents.id, id),
    eq(outboxEvents.leaseToken, leaseToken),
    isNull(outboxEvents.publishedAt),
    isNull(outboxEvents.failedAt),
  );
}

/** The job kinds a stranded run depends on, and which can be rebuilt from it. */
export const RUN_DELIVERY_JOB_NAMES = [
  'advance-workflow-run',
  'execute-node-attempt',
] as const;

const runDeliveryJob = sql`${outboxEvents.jobName} in ${RUN_DELIVERY_JOB_NAMES}`;

/** A queue under real load delivers well inside this; past it, the job is presumed lost. */
const DELIVERY_CONFIRMATION_SECONDS = 60;
const MAXIMUM_DELIVERY_CONFIRMATION_SECONDS = 3_600;

/**
 * Doubles with each redelivery: a backlog that is merely slow is asked again less
 * and less often, and a job that can't be confirmed costs a retry an hour at most.
 */
const deliveryDueTime = sql`clock_timestamp()+make_interval(secs=>least(${MAXIMUM_DELIVERY_CONFIRMATION_SECONDS},${DELIVERY_CONFIRMATION_SECONDS}*power(2,least(${outboxEvents.redeliveries},12))))`;

async function markPublished(
  pool: Pool,
  eventId: string,
  leaseToken: string,
): Promise<boolean> {
  const db = drizzle(pool);
  const published = db.$with('published').as(
    db
      .update(outboxEvents)
      .set({
        publishedAt: sql`clock_timestamp()`,
        deliveryDueAt: deliveryDueTime,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(currentLease(eventId, leaseToken))
      .returning({
        workspaceId: outboxEvents.workspaceId,
        id: outboxEvents.id,
      }),
  );
  const result = await db
    .with(published)
    .select({
      id: published.id,
      armedAdmission: sql<boolean>`app.arm_dispatcher_workflow_run_active_admission(${published.workspaceId},${published.id})`,
    })
    .from(published)
    .catch(rethrowQueryFailure);
  return result.length === 1;
}
async function releaseOrFail(
  pool: Pool,
  input: ReleaseInput,
): Promise<ReleaseOutboxResult> {
  const db = drizzle(pool);
  const outcome =
    input.disposition === 'fail'
      ? {
          failedAt: sql`clock_timestamp()`,
          // A run must not wait on a row that can never publish.
          deliveryDueAt: sql`case when ${runDeliveryJob} then clock_timestamp() end`,
        }
      : { availableAt: sql`${input.retryAt}::timestamptz` };
  const updated = db.$with('updated').as(
    db
      .update(outboxEvents)
      .set({
        ...outcome,
        lastErrorCode: input.errorCode,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(currentLease(input.id, input.leaseToken))
      .returning({
        failed: sql<boolean>`${outboxEvents.failedAt} is not null`.as('failed'),
        workspaceId: outboxEvents.workspaceId,
        id: outboxEvents.id,
      }),
  );
  const [row] = await db
    .with(updated)
    .select({
      failed: updated.failed,
      releasedAdmission: sql<boolean>`case when ${updated.failed} then app.release_dispatcher_workflow_run_active_admission(${updated.workspaceId},${updated.id}) else false end`,
    })
    .from(updated)
    .catch(rethrowQueryFailure);
  if (row === undefined) return 'not_leased';
  return row.failed ? 'failed' : 'retry_scheduled';
}
export function createOutboxDispatcherDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): OutboxDispatcherDatabase {
  const { ownerRole, ...poolConfig } = config;
  const lease = acquireDatabasePool({ ...config, ...poolConfig }, runtime, {
    role: 'dispatcher',
  });
  const { pool } = lease;
  return Object.freeze({
    claimBatch: (input: ClaimOutboxBatchInput) => claimOutboxBatch(pool, input),
    markPublished: (eventId: string, leaseToken: string) =>
      markPublished(pool, eventId, leaseToken),
    releaseOrFail: (input: ReleaseInput) => releaseOrFail(pool, input),
    observeBacklog: (input: ObserveOutboxBacklogInput) =>
      observeOutboxBacklog(pool, input),
    checkReadiness: async () => {
      await checkDatabaseReadiness(pool);
    },
    close: () => lease.close(),
  });
}
