import {
  workflowRuns,
  workflowCalls,
  workflowRunActiveAdmissions,
} from '@pertexo/database/schema';
import {
  and,
  asc,
  eq,
  exists,
  getTableName,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  RUN_DETAILS_RETENTION_SQL,
  RUN_SUMMARY_RETENTION_SQL,
} from '../../runs/data-policy.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

type CallWorkColumns = Readonly<{
  slotLent: AnyPgColumn<{ data: boolean }>;
  status: AnyPgColumn<{ data: string }>;
  cancelRequestedAt: AnyPgColumn<{ data: Date | string }>;
  cancelAppliedAt: AnyPgColumn<{ data: Date | string }>;
}>;

/** No slot, admission or cancellation work still uses this call. */
export function callHasNoPendingWork(call: CallWorkColumns): SQL<boolean> {
  return sql`${and(eq(call.slotLent, false), notInArray(call.status, ['pending', 'accepted']), or(isNull(call.cancelRequestedAt), isNotNull(call.cancelAppliedAt)))}`;
}

/** Call payloads follow their parent's detail window; identity follows its summary. */
export const CALL_DETAILS_RETENTION_RULE = {
  name: 'call_details',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client),
      parent = alias(workflowRuns, 'parent');
    const page = db.$with('page').as(
      db
        .select({ id: workflowCalls.id })
        .from(workflowCalls)
        .innerJoin(
          parent,
          and(
            eq(parent.workspaceId, workflowCalls.workspaceId),
            eq(parent.id, workflowCalls.parentRunId),
          ),
        )
        .where(
          and(
            isNull(workflowCalls.detailsPurgedAt),
            isNotNull(workflowCalls.consumedAt),
            callHasNoPendingWork(workflowCalls),
            sql`${parent.completedAt}<=clock_timestamp()-${RUN_DETAILS_RETENTION_SQL}`,
          ),
        )
        .orderBy(asc(parent.completedAt), asc(workflowCalls.id))
        .limit(pageSize)
        .for('update', {
          of: alias(workflowCalls, getTableName(workflowCalls)),
          skipLocked: true,
        }),
    );
    return (
      await db
        .with(page)
        .update(workflowCalls)
        .set({
          inputRef: null,
          resultRef: null,
          detailsPurgedAt: sql`clock_timestamp()`,
        })
        .from(page)
        .where(eq(workflowCalls.id, page.id))
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;

/** Detach an expired child's live FK while preserving its immutable outcome ID. */
export const CALL_CHILD_REFERENCES_RETENTION_RULE = {
  name: 'call_child_references',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client),
      child = alias(workflowRuns, 'child');
    const page = db.$with('page').as(
      db
        .select({ workspaceId: child.workspaceId, id: child.id })
        .from(child)
        .where(
          and(
            sql`${child.completedAt}<=clock_timestamp()-${RUN_SUMMARY_RETENTION_SQL}`,
            isNotNull(child.detailsPurgedAt),
            exists(
              db
                .select({ one: sql`1` })
                .from(workflowCalls)
                .where(
                  and(
                    eq(workflowCalls.workspaceId, child.workspaceId),
                    eq(workflowCalls.liveChildRunId, child.id),
                    callHasNoPendingWork(workflowCalls),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(workflowRunActiveAdmissions)
                .where(
                  and(
                    eq(
                      workflowRunActiveAdmissions.workspaceId,
                      child.workspaceId,
                    ),
                    eq(workflowRunActiveAdmissions.workflowRunId, child.id),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(child.completedAt), asc(child.id))
        .limit(pageSize)
        .for('update', { of: child, skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .update(workflowCalls)
        .set({ liveChildRunId: null })
        .from(page)
        .where(
          and(
            eq(workflowCalls.workspaceId, page.workspaceId),
            eq(workflowCalls.liveChildRunId, page.id),
            callHasNoPendingWork(workflowCalls),
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
