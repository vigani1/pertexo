import { sql, and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import {
  rethrowQueryFailure,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import {
  triggerSchedules,
  triggerSchedules as schedules,
  triggerScheduleOccurrences as occurrences,
  workflows,
  workflowVersions,
  workflowTriggers,
  workspaces,
} from '@pertexo/database/schema';
import {
  withPlatformTransaction,
  generatePersistedId,
} from '@pertexo/database/platform';
import { scheduleStandingColumns } from '../schedule-standing.js';
import type { RecordedScheduleOccurrence } from '../schedule-occurrence.types.js';
import type {
  ClaimedOccurrence,
  ScanDueInput,
  ScheduleClaim,
} from './schedule-scanning.types.js';

/** Claims a bounded page of due schedules, as the rows the SQL claim returned. */
export async function claimDueScheduleRows(
  claimPool: Pool,
  input: ScanDueInput,
) {
  const leaseOwner = input.leaseOwner;
  const limit = input.limit;
  const leaseSeconds = input.leaseSeconds;
  const result = await withPlatformTransaction(
    claimPool,
    (client) =>
      drizzle(client)
        .select({
          trigger_id: sql<string>`claim.trigger_id`,
          workspace_id: sql<string>`claim.workspace_id`,
          workflow_id: sql<string>`claim.workflow_id`,
          workflow_version_id: sql<string>`claim.workflow_version_id`,
          node_id: sql<string>`claim.node_id`,
          recurrence_kind: sql<'cron' | 'interval'>`claim.recurrence_kind`,
          cron_expression: sql<string | null>`claim.cron_expression`,
          timezone: sql<string | null>`claim.timezone`,
          interval_minutes: sql<number | null>`claim.interval_minutes`,
          misfire_policy: sql<'catch_up_once' | 'skip'>`claim.misfire_policy`,
          config_fingerprint: sql<string>`claim.config_fingerprint`,
          anchor_at: sql<Date>`claim.anchor_at`.mapWith(
            triggerSchedules.anchorAt,
          ),
          next_fire_at: sql<Date>`claim.next_fire_at`.mapWith(
            triggerSchedules.nextFireAt,
          ),
          lease_token: sql<string>`claim.lease_token`,
          observed_at: sql<Date>`claim.observed_at`.mapWith(
            triggerSchedules.createdAt,
          ),
        })
        .from(
          sql`app.claim_due_trigger_schedules(${leaseOwner},${limit},${leaseSeconds}) as claim`,
        )
        .catch(rethrowQueryFailure),

    input.signal === undefined ? {} : { signal: input.signal },
  );
  return result;
}

/** The claimed schedule's standing, while its lease is still live. */
export async function readClaimStanding(
  transaction: WorkspaceTransaction,
  claim: Readonly<{ trigger_id: string; lease_token: string }>,
) {
  const eligible = await transaction.db
    .select(scheduleStandingColumns)
    .from(schedules)
    .innerJoin(workflowTriggers, eq(workflowTriggers.id, schedules.triggerId))
    .innerJoin(workflows, eq(workflows.id, workflowTriggers.workflowId))
    .innerJoin(workspaces, eq(workspaces.id, workflowTriggers.workspaceId))
    .where(
      and(
        eq(schedules.triggerId, claim.trigger_id),
        eq(schedules.leaseToken, claim.lease_token),
        sql`${schedules.leaseExpiresAt}>clock_timestamp()`,
      ),
    );
  return eligible[0];
}

export async function readClaimedVersion(
  transaction: WorkspaceTransaction,
  claim: ScheduleClaim,
) {
  const version = await transaction.db
    .select({
      id: workflowVersions.id,
      workspaceId: workflowVersions.workspaceId,
      workflowId: workflowVersions.workflowId,
      versionNumber: workflowVersions.versionNumber,
      checksum: workflowVersions.checksum,
      executableJson: workflowVersions.executableJson,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, claim.workspace_id),
        eq(workflowVersions.id, claim.workflow_version_id),
      ),
    );
  return version[0];
}

/** Locks the schedule while the claim's lease is live; false once it lapsed. */
export async function lockLiveClaim(
  transaction: WorkspaceTransaction,
  claim: ScheduleClaim,
) {
  const schedule = await transaction.db
    .select({ one: sql`1` })
    .from(schedules)
    .where(
      and(
        eq(schedules.triggerId, claim.trigger_id),
        eq(schedules.leaseToken, claim.lease_token),
        sql`${schedules.leaseExpiresAt}>clock_timestamp()`,
      ),
    )
    .for('update');
  return schedule.length === 1;
}

/** Records the occurrence once; false when it was already recorded. */
export async function insertOccurrence(
  transaction: WorkspaceTransaction,
  claim: ScheduleClaim,
  input: Readonly<{
    occurrence: ClaimedOccurrence;
    disposition: RecordedScheduleOccurrence;
    runId: string | null;
    skipReason: 'concurrency_limit' | null;
  }>,
) {
  const { occurrence, disposition, runId, skipReason } = input;
  const recorded = await transaction.db
    .insert(occurrences)
    .values({
      id: generatePersistedId(),
      workspaceId: transaction.workspaceId,
      triggerId: claim.trigger_id,
      scheduledAt: occurrence.scheduledAt,
      disposition,
      workflowRunId: runId,
      skipReason,
    })
    .onConflictDoNothing({
      target: [occurrences.triggerId, occurrences.scheduledAt],
    })
    .returning({ id: occurrences.id });
  return recorded.length === 1;
}

/** Moves the schedule on, releases its lease and marks it and its trigger healthy. */
export async function advanceClaimedSchedule(
  transaction: WorkspaceTransaction,
  claim: ScheduleClaim,
  occurrence: ClaimedOccurrence,
) {
  await transaction.db
    .update(schedules)
    .set({
      lastFireAt: occurrence.scheduledAt,
      nextFireAt: occurrence.nextAt,
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      admissionDeferredUntil: null,
      healthStatus: 'healthy',
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedules.triggerId, claim.trigger_id),
        eq(schedules.leaseToken, claim.lease_token),
      ),
    );
  await transaction.db
    .update(workflowTriggers)
    .set({
      healthStatus: 'healthy',
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowTriggers.id, claim.trigger_id),
        eq(workflowTriggers.workspaceId, transaction.workspaceId),
      ),
    );
}
