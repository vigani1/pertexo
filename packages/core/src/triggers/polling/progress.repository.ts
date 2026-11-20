import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { HttpPollFailureCode } from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  triggerPolls as polls,
  workflowTriggers as triggers,
  workflows as workflowRecords,
  workflowVersions,
  workspaces,
} from '@pertexo/database/schema';
import type { PollClaim } from '../schedules/scanning/schedule-scanning.types.js';

const workflows = alias(workflowRecords, 'poll_workflow');

const servingPoll = (claim: PollClaim) =>
  and(
    eq(polls.workspaceId, claim.workspace_id),
    eq(polls.triggerId, claim.trigger_id),
    eq(polls.leaseToken, claim.lease_token),
    isNull(polls.retiredAt),
    sql`${polls.leaseExpiresAt}>clock_timestamp()`,
  );

function triggerCurrent(claim: PollClaim) {
  return and(
    eq(triggers.workspaceId, claim.workspace_id),
    eq(triggers.id, claim.trigger_id),
    eq(triggers.status, 'active'),
    eq(workflows.publishedVersionId, triggers.workflowVersionId),
    eq(workflows.lifecycleStatus, 'active'),
    inArray(workflows.activationStatus, ['active', 'degraded']),
    ne(workflows.triggerPauseState, 'paused'),
  );
}

const currentWorkflow = and(
  eq(workflows.workspaceId, triggers.workspaceId),
  eq(workflows.id, triggers.workflowId),
);

export async function readPollObservation(
  transaction: WorkspaceTransaction,
  claim: PollClaim,
) {
  const [row] = await transaction.db
    .select({
      config: triggers.desiredConfig,
      workflowId: triggers.workflowId,
      seenKeys: polls.seenKeys,
      pauseRevision: workflows.triggerPauseRevision,
      observedAt: sql<Date>`clock_timestamp()`.mapWith(polls.nextPollAt),
    })
    .from(polls)
    .innerJoin(
      triggers,
      and(
        eq(triggers.id, polls.triggerId),
        eq(triggers.workspaceId, polls.workspaceId),
      ),
    )
    .innerJoin(workflows, currentWorkflow)
    .where(and(servingPoll(claim), triggerCurrent(claim)));
  return row;
}

/** Workflow publication and pause are checked under their lock before locking the poll. */
export async function lockPollPublication(
  transaction: WorkspaceTransaction,
  claim: PollClaim,
  pauseRevision: bigint,
  lock: 'share' | 'no key update' = 'share',
) {
  const [published] = await transaction.db
    .select({
      id: workflowVersions.id,
      workspaceId: workflowVersions.workspaceId,
      workflowId: workflowVersions.workflowId,
      versionNumber: workflowVersions.versionNumber,
      checksum: workflowVersions.checksum,
      executableJson: workflowVersions.executableJson,
      nodeId: triggers.nodeId,
      autoPauseEnabled: workflows.autoPauseEnabled,
      threshold: sql<number>`coalesce(${workflows.autoPauseThreshold}, ${workspaces.autoPauseThreshold})`,
    })
    .from(triggers)
    .innerJoin(workflows, currentWorkflow)
    .innerJoin(workspaces, eq(workspaces.id, workflows.workspaceId))
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.id, triggers.workflowVersionId),
        eq(workflowVersions.workspaceId, triggers.workspaceId),
      ),
    )
    .where(
      and(
        triggerCurrent(claim),
        eq(workflows.triggerPauseRevision, pauseRevision),
      ),
    )
    .for(lock, { of: workflows });
  if (published === undefined) return undefined;
  const [poll] = await transaction.db
    .select({
      seenKeys: polls.seenKeys,
      consecutiveFailures: polls.consecutiveFailures,
      failurePauseRevision: polls.failurePauseRevision,
    })
    .from(polls)
    .where(servingPoll(claim))
    .for('update');
  if (poll === undefined) return undefined;
  return { published, ...poll };
}

export async function recordPollKeys(
  transaction: WorkspaceTransaction,
  claim: PollClaim,
  keys: readonly Buffer[],
) {
  const rows = await transaction.db
    .update(polls)
    .set({
      seenKeys: sql`ARRAY[${sql.join(
        keys.map((key) => sql`${key}::bytea`),
        sql`, `,
      )}]::bytea[]`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(servingPoll(claim))
    .returning({ id: polls.triggerId });
  return rows.length === 1;
}

export async function completePoll(
  transaction: WorkspaceTransaction,
  claim: PollClaim,
  delaySeconds: number,
  outcome:
    | { kind: 'success' }
    | {
        kind: 'failure';
        code: HttpPollFailureCode;
        count: number;
        pauseRevision: bigint;
      },
) {
  const rows = await transaction.db
    .update(polls)
    .set({
      ...(outcome.kind === 'success'
        ? { consecutiveFailures: 0, failurePauseRevision: null }
        : {
            consecutiveFailures: outcome.count,
            failurePauseRevision: outcome.pauseRevision,
          }),
      nextPollAt: sql`statement_timestamp()+make_interval(secs=>${delaySeconds})`,
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(servingPoll(claim))
    .returning({ id: polls.triggerId });
  if (rows.length === 0) return false;
  const errorCode = outcome.kind === 'failure' ? outcome.code : null;
  const failedHealth =
    errorCode === 'http.poll_authentication' ? 'unhealthy' : 'degraded';
  await transaction.db
    .update(triggers)
    .set({
      healthStatus: errorCode === null ? 'healthy' : failedHealth,
      lastErrorCode: errorCode,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(triggers.workspaceId, claim.workspace_id),
        eq(triggers.id, claim.trigger_id),
      ),
    );
  return true;
}
