import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { workflowTestSuites } from '@pertexo/database/schema';
import { advanceSuite } from './advance.js';
import type { WorkflowTestSuiteScanner } from './contract.js';
/** Global discovery uses maintenance; all progress and admission are tenant scoped. */
export async function createWorkflowTestSuiteScanner(
  config: DatabaseConfig,
  maintenance: DatabaseConfig,
  runtimes: Readonly<{
    runtime?: DatabaseRuntime;
    maintenanceRuntime?: DatabaseRuntime;
  }> = {},
): Promise<WorkflowTestSuiteScanner> {
  const writes = acquireDatabasePool(config, runtimes.runtime);
  let discovery: ReturnType<typeof acquireDatabasePool>;
  try {
    discovery = acquireDatabasePool(maintenance, runtimes.maintenanceRuntime);
  } catch (error) {
    try {
      await writes.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Suite scanner construction and cleanup failed',
      );
    }
    throw error;
  }
  let after: { at: Date; id: string } | undefined;
  return {
    scan: async (limit, signal) => {
      signal?.throwIfAborted();
      const candidates = await drizzle(discovery.pool)
        .select({
          id: workflowTestSuites.id,
          workspaceId: workflowTestSuites.workspaceId,
          workflowId: workflowTestSuites.workflowId,
          startedBy: workflowTestSuites.startedBy,
          nextCheckAt: workflowTestSuites.nextCheckAt,
        })
        .from(workflowTestSuites)
        .where(
          and(
            eq(workflowTestSuites.status, 'running'),
            sql`${workflowTestSuites.expiresAt}>clock_timestamp()`,
            sql`${workflowTestSuites.nextCheckAt}<=clock_timestamp()`,
            after === undefined
              ? undefined
              : sql`(${workflowTestSuites.nextCheckAt},${workflowTestSuites.id})>(${after.at},${after.id}::uuid)`,
          ),
        )
        .orderBy(
          asc(workflowTestSuites.nextCheckAt),
          asc(workflowTestSuites.id),
        )
        .limit(limit)
        .catch(rethrowQueryFailure);
      let advanced = 0;
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        if (
          await withTenantScopedClient(
            writes.pool,
            {
              workspaceId: candidate.workspaceId,
              actorId: candidate.startedBy,
            },
            (client) => advanceSuite(client, candidate),
            {
              ...(signal === undefined ? {} : { signal }),
              statementTimeoutMillis: 2000,
            },
          )
        )
          advanced++;
        after = { at: candidate.nextCheckAt, id: candidate.id };
      }
      if (candidates.length < limit) after = undefined;
      return advanced;
    },
    close: async () => {
      const results = await Promise.allSettled([
        writes.close(),
        discovery.close(),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
