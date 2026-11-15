import { drizzle } from 'drizzle-orm/node-postgres';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { advanceSuite } from './advance.js';
import { findDueSuites } from './suite-state.repository.js';
import type { WorkflowTestSuiteScanner } from './workflow-test-suite.types.js';
/** How long one statement of advancing a suite may run. */
const ADVANCE_STATEMENT_TIMEOUT_MILLIS = 2_000;

/**
 * Global discovery uses maintenance; all progress and admission are tenant
 * scoped. The worker acts for whoever started the suite, and losing their
 * authority stops the suite rather than being refused, so this stays off
 * withWorkspaceAccess.
 */
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
      const candidates = await findDueSuites(
        drizzle(discovery.pool),
        after,
        limit,
      );
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
              statementTimeoutMillis: ADVANCE_STATEMENT_TIMEOUT_MILLIS,
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
