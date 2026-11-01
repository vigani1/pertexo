import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq, exists, notExists } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  workspaceVariables,
  workspaceVariableSetRevisions as revisions,
  workflowRuns,
  previewRuns,
  workflowTestSuites,
} from '@pertexo/database/schema';

function unreferenced(db: NodePgDatabase) {
  return and(
    notExists(
      db
        .select({ revision: workspaceVariables.revision })
        .from(workspaceVariables)
        .where(
          and(
            eq(workspaceVariables.workspaceId, revisions.workspaceId),
            eq(workspaceVariables.revision, revisions.revision),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workspaceId, revisions.workspaceId),
            eq(workflowRuns.variableSetRevision, revisions.revision),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: workflowTestSuites.id })
        .from(workflowTestSuites)
        .where(
          and(
            eq(workflowTestSuites.workspaceId, revisions.workspaceId),
            eq(workflowTestSuites.variableSetRevision, revisions.revision),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: previewRuns.id })
        .from(previewRuns)
        .where(
          and(
            eq(previewRuns.workspaceId, revisions.workspaceId),
            eq(previewRuns.variableSetRevision, revisions.revision),
          ),
        ),
    ),
  );
}

/** References, not age, own a set's lifetime; current configuration is always retained. */
export const VARIABLE_SET_RETENTION_RULE = {
  name: 'variable_sets',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db.$with('page').as(
      db
        .select({
          workspaceId: revisions.workspaceId,
          revision: revisions.revision,
        })
        .from(revisions)
        .where(unreferenced(db))
        .orderBy(revisions.workspaceId, revisions.revision)
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    const removed = await db
      .with(page)
      .delete(revisions)
      .where(
        and(
          exists(
            db
              .select({ revision: page.revision })
              .from(page)
              .where(
                and(
                  eq(page.workspaceId, revisions.workspaceId),
                  eq(page.revision, revisions.revision),
                ),
              ),
          ),
          unreferenced(db),
        ),
      )
      .returning({ revision: revisions.revision })
      .catch(rethrowQueryFailure);
    return removed.length;
  },
} as const;
