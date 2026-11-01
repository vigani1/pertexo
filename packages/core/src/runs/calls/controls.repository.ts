import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  workflowCalls,
  workflowRuns,
  databaseSchema,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  parseWorkspaceId,
} from '@pertexo/database/primitives';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { requestWorkflowRunCancellation } from '../commands/cancel.repository.js';
import { terminalRunStatuses } from '../advance/plan.js';
import { wakeWorkflowRun } from './wakeup.repository.js';

/** A child consumes its direct parent's intent under its own run lock only. */
export async function applyIncomingCallCancellation(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  traceparent?: string,
): Promise<boolean> {
  const db = drizzle(client),
    c = workflowCalls,
    r = workflowRuns;
  const [call] = await db
    .select({ id: c.id })
    .from(c)
    .where(
      and(
        eq(c.workspaceId, workspaceId),
        eq(c.childRunId, runId),
        isNotNull(c.cancelRequestedAt),
        isNull(c.cancelAppliedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  if (call === undefined) return false;
  const [row] = await db
    .select({ status: r.status, cancel_requested_at: r.cancelRequestedAt })
    .from(r)
    .where(and(eq(r.workspaceId, workspaceId), eq(r.id, runId)))
    .for('no key update')
    .catch(rethrowQueryFailure);
  if (row === undefined) return false;
  if (
    !terminalRunStatuses.has(row.status) &&
    row.cancel_requested_at === null
  ) {
    await requestWorkflowRunCancellation(
      {
        db: drizzle(client, { schema: databaseSchema }),
        workspaceId: parseWorkspaceId(workspaceId),
      },
      { runId, actor: `workflow-call:${call.id}`, reason: 'parent_closed' },
    );
    await wakeWorkflowRun(client, workspaceId, runId, traceparent);
  }
  await db
    .update(c)
    .set({ cancelAppliedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(c.workspaceId, workspaceId),
        eq(c.id, call.id),
        isNull(c.cancelAppliedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  return true;
}
