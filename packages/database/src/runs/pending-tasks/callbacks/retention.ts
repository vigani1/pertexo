import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { workflowRuns } from '../../../schema/runs/execution.js';
import { and, asc, eq, exists, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { expiredRunSql } from '../../data-policy.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';

/** Bound tasks already cascade with node details; prepared tasks have no node. */
export const CALLBACK_TASK_RETENTION_RULE = {
  name: 'prepared_callbacks',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client),
      task = alias(pendingRunTasks, 'task'),
      owner = alias(workflowRuns, 'run');
    const page = db.$with('page').as(
      db
        .select({ id: task.id })
        .from(task)
        .innerJoin(
          owner,
          and(
            eq(owner.workspaceId, task.workspaceId),
            eq(owner.id, task.runId),
          ),
        )
        .where(
          and(
            eq(task.kind, 'callback'),
            isNull(task.nodeRunId),
            expiredRunSql('run'),
          ),
        )
        .orderBy(asc(task.id))
        .limit(pageSize)
        .for('update', { of: task, skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .delete(pendingRunTasks)
        .where(
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(eq(page.id, pendingRunTasks.id)),
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
