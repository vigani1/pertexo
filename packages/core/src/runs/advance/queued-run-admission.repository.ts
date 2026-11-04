import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { RunStatus } from '@pertexo/workflow-engine';
import { workflowRuns } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  CoordinatorRunStateCorruptError,
  ExecutionStateConflictError,
} from '../state-errors.js';

/** The caller holds the workspace/current entitlement fence, then run and capacity locks. */
export async function assertRunStartDeadline(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    currentStatus: RunStatus;
    nextStatus: RunStatus;
  }>,
): Promise<void> {
  if (!startsRunExecution(input.currentStatus, input.nextStatus)) return;
  const [facts] = await drizzle(client)
    .select({
      deadline: sql<
        string | null
      >`extract(epoch from ${workflowRuns.deadlineAt})::text`,
      observedAt: sql<string>`extract(epoch from clock_timestamp())::text`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, input.workspaceId),
        eq(workflowRuns.id, input.runId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (facts === undefined) throw new CoordinatorRunStateCorruptError();
  // Keep these retryable: a fresh coordinator turn consumes the control fact
  // and persists its truthful terminal outcome, rather than failing the run.
  if (
    facts.deadline !== null &&
    Number(facts.deadline) <= Number(facts.observedAt)
  )
    throw new ExecutionStateConflictError('execution.run_start_expired');
}

/** Cancellation metadata is already protected by the caller's run lock. */
export function assertRunStartNotCanceled(canceledAt: Date | null): void {
  if (canceledAt !== null)
    throw new ExecutionStateConflictError('execution.run_start_canceled');
}

/** Capacity and control fences apply to the same execution-start transition. */
export function startsRunExecution(
  current: RunStatus,
  next: RunStatus,
): boolean {
  return current === 'queued' && (next === 'running' || next === 'waiting');
}
