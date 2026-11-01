import { workflowRunValues, workflowRuns } from '@pertexo/database/schema';
import { and, asc, eq, exists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { expiredRunSql } from '../data-policy.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export const RUN_VALUES_RETENTION_RULE = {
  name: 'workflow_run_values',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client),
      value = alias(workflowRunValues, 'value'),
      owner = alias(workflowRuns, 'run');
    const page = db.$with('page').as(
      db
        .select({ workspaceId: value.workspaceId, id: value.id })
        .from(value)
        .innerJoin(
          owner,
          and(
            eq(owner.workspaceId, value.workspaceId),
            eq(owner.id, value.workflowRunId),
          ),
        )
        .where(expiredRunSql('run'))
        .orderBy(asc(value.id))
        .limit(pageSize)
        .for('update', { of: value, skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .delete(workflowRunValues)
        .where(
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(
                and(
                  eq(page.workspaceId, workflowRunValues.workspaceId),
                  eq(page.id, workflowRunValues.id),
                ),
              ),
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
