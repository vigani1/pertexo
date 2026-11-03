import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import {
  workflowFailureStreaks as streaks,
  workflowTriggerOutcomes as outcomes,
  workflowTriggerFailures as failures,
  workflows,
  workspaces,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import {
  advanceSuccessWatermark,
  compareCompletions,
  pauseEvidence,
  type CompletionPosition,
  type TriggerOutcome,
} from './failure-streak.js';
import {
  lockAutoPauseWorkspace,
  lockAutoPauseWorkflow,
} from './locks.repository.js';
import type { WorkflowTriggerPauseDecision } from './trigger-pause.types.js';

export async function foldTriggerOutcomes(client: PoolClient, limit: number) {
  const db = drizzle(client);
  // Do not claim queue rows before workspace/workflow serialization: resume and
  // completion producers must never wait in an outcome -> workflow lock cycle.
  const candidates = await db
    .select({
      id: outcomes.id,
      workspaceId: outcomes.workspaceId,
      workflowId: outcomes.workflowId,
    })
    .from(outcomes)
    .orderBy(outcomes.createdAt, outcomes.id)
    .limit(limit)
    .catch(rethrowQueryFailure);
  const groups = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const key = `${row.workspaceId}:${row.workflowId}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const decisions: WorkflowTriggerPauseDecision[] = [];
  for (const [, group] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const first = group[0];
    if (first === undefined) continue;
    const decision = await foldWorkflow(
      client,
      { workspaceId: first.workspaceId, workflowId: first.workflowId },
      group.map(({ id }) => id),
    );
    if (decision !== null) decisions.push(Object.freeze(decision));
  }
  return Object.freeze(decisions);
}

async function foldWorkflow(
  client: PoolClient,
  scope: Readonly<{ workspaceId: string; workflowId: string }>,
  candidateIds: string[],
): Promise<WorkflowTriggerPauseDecision | null> {
  const { workspaceId, workflowId } = scope;
  const db = drizzle(client);
  await db
    .execute(sql`select set_config('app.workspace_id',${workspaceId},true)`)
    .catch(rethrowQueryFailure);
  await lockAutoPauseWorkspace(client, workspaceId, false);
  const [workspace] = await db
    .select({
      status: workspaces.status,
      threshold: workspaces.autoPauseThreshold,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  if (workspace === undefined) return null;
  await lockAutoPauseWorkflow(client, workspaceId, workflowId);
  const [workflow] = await db
    .select({
      enabled: workflows.autoPauseEnabled,
      threshold: workflows.autoPauseThreshold,
      lifecycle: workflows.lifecycleStatus,
      pauseState: workflows.triggerPauseState,
    })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('no key update')
    .catch(rethrowQueryFailure);
  if (workflow === undefined) return null;
  const batch = await db
    .select({
      id: outcomes.id,
      runId: outcomes.runId,
      countsAsFailure: outcomes.countsAsFailure,
      endedAt: completionTime(outcomes.endedAt),
    })
    .from(outcomes)
    .where(
      and(
        inArray(outcomes.id, candidateIds),
        eq(outcomes.workspaceId, workspaceId),
        eq(outcomes.workflowId, workflowId),
      ),
    )
    .orderBy(outcomes.endedAt, outcomes.id)
    .for('update', { skipLocked: true })
    .catch(rethrowQueryFailure);
  if (batch.length === 0) return null;
  await db
    .delete(outcomes)
    .where(
      inArray(
        outcomes.id,
        batch.map(({ id }) => id),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .insert(streaks)
    .values({ ...scope, consecutiveFailures: 0 })
    .onConflictDoNothing()
    .catch(rethrowQueryFailure);
  const [prior] = await db
    .select({
      legacyFailures: streaks.legacyFailures,
      resumedAfter: completionTime(streaks.resumedAfter),
      success: sql<CompletionPosition | null>`case when ${streaks.successEndedAt} is null then null
        else jsonb_build_object('endedAt',${completionTime(streaks.successEndedAt)},'id',${streaks.successOutcomeId}) end`,
      lastRunId: streaks.lastRunId,
      lastEndedAt: completionTime(streaks.lastEndedAt),
    })
    .from(streaks)
    .where(
      and(
        eq(streaks.workspaceId, workspaceId),
        eq(streaks.workflowId, workflowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (prior === undefined)
    throw new Error('Workflow failure streak is unavailable');
  const eligible = batch.filter(
    ({ endedAt }) =>
      prior.resumedAfter === null || endedAt > prior.resumedAfter,
  );
  if (eligible.length === 0) return null;
  const threshold = workflow.threshold ?? workspace.threshold;
  const evidence = await applyOrderedOutcomes(client, scope, prior, {
    outcomes: eligible,
    threshold,
  });
  if (
    evidence === null ||
    !workflow.enabled ||
    workflow.lifecycle !== 'active' ||
    workflow.pauseState !== 'none' ||
    !ACTIVE_WORKSPACE_STATUSES.some((status) => status === workspace.status)
  )
    return null;
  await db
    .update(workflows)
    .set({
      triggerPauseState: 'paused',
      triggerPausedAt: sql`clock_timestamp()`,
      triggerPauseReason: 'consecutive_failures',
      triggerPauseFailures: evidence.failures,
      triggerPauseLastRunId: evidence.runId,
      triggerPauseRevision: sql`${workflows.triggerPauseRevision}+1`,
    })
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  await appendAuditFact(client, {
    workspaceId,
    action: 'workflow.triggers_paused',
    targetType: 'workflow',
    targetId: workflowId,
    metadata: {
      reason: 'consecutive_failures',
      failures: evidence.failures,
      threshold,
      lastRunId: evidence.runId,
    },
  });
  return { ...scope, consecutiveFailures: evidence.failures };
}

type StreakHistory = Readonly<{
  legacyFailures: number;
  resumedAfter: string | null;
  success: CompletionPosition | null;
  lastRunId: string | null;
  lastEndedAt: string | null;
}>;

async function applyOrderedOutcomes(
  client: PoolClient,
  scope: Readonly<{ workspaceId: string; workflowId: string }>,
  prior: StreakHistory,
  batch: Readonly<{ outcomes: readonly TriggerOutcome[]; threshold: number }>,
) {
  const { outcomes: eligible, threshold } = batch;
  const db = drizzle(client);
  const { workspaceId, workflowId } = scope;
  const success = advanceSuccessWatermark(prior.success, eligible);
  const legacyFailures = success === null ? prior.legacyFailures : 0;
  const additions = eligible.filter(
    (outcome) =>
      outcome.countsAsFailure &&
      (success === null || compareCompletions(outcome, success) > 0),
  );
  if (additions.length > 0)
    await db
      .insert(failures)
      .values(
        additions.map(({ id, runId, endedAt }) => ({
          ...scope,
          id,
          runId,
          endedAt,
        })),
      )
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
  await db
    .update(streaks)
    .set({
      legacyFailures,
      successEndedAt: success?.endedAt ?? null,
      successOutcomeId: success?.id ?? null,
    })
    .where(
      and(
        eq(streaks.workspaceId, workspaceId),
        eq(streaks.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  const retained = and(
    eq(failures.workspaceId, workspaceId),
    eq(failures.workflowId, workflowId),
    prior.resumedAfter === null
      ? undefined
      : sql`${failures.endedAt}>${prior.resumedAfter}::timestamptz`,
    success === null
      ? undefined
      : sql`(${failures.endedAt},${failures.id})>(${success.endedAt}::timestamptz,${success.id}::uuid)`,
  );
  const [count] = await db
    .select({ value: sql<number>`count(*)::integer` })
    .from(failures)
    .where(retained)
    .catch(rethrowQueryFailure);
  // Only the threshold's first positions and the latest position need to cross
  // the wire; the durable suffix can be longer than a fold's batch.
  const firstFailures = await db
    .select({ runId: failures.runId })
    .from(failures)
    .where(retained)
    .orderBy(failures.endedAt, failures.id)
    .limit(threshold)
    .catch(rethrowQueryFailure);
  const [latestFailure] = await db
    .select({
      id: failures.id,
      runId: failures.runId,
      endedAt: completionTime(failures.endedAt),
    })
    .from(failures)
    .where(retained)
    .orderBy(sql`${failures.endedAt} desc`, sql`${failures.id} desc`)
    .limit(1)
    .catch(rethrowQueryFailure);
  const latestSuccess =
    success === null ? undefined : eligible.find(({ id }) => id === success.id);
  const last = latestFailure ?? latestSuccess;
  const consecutiveFailures = legacyFailures + (count?.value ?? 0);
  await db
    .update(streaks)
    .set({
      consecutiveFailures,
      lastRunId: last?.runId ?? prior.lastRunId,
      lastEndedAt: last?.endedAt ?? prior.lastEndedAt,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(streaks.workspaceId, workspaceId),
        eq(streaks.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return pauseEvidence(legacyFailures, firstFailures, threshold);
}

function completionTime<T extends AnyPgColumn>(
  column: T,
): SQL<T['_']['notNull'] extends true ? string : string | null> {
  return sql`to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
