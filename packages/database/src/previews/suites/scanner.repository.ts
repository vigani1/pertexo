import { isIntegerInRange } from '../../platform/persisted-primitives.js';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { advanceSuite } from './advance.repository.js';
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
      const invalidLimit = !isIntegerInRange(limit, 1, 100);
      if (invalidLimit)
        throw new RangeError('Suite scan limit must be between 1 and 100');
      const candidates = await discovery.pool.query<{
        id: string;
        workspace_id: string;
        workflow_id: string;
        started_by: string;
        next_check_at: Date;
      }>(
        "select id,workspace_id,workflow_id,started_by,next_check_at from app.workflow_test_suites where status='running' and expires_at>clock_timestamp() and next_check_at<=clock_timestamp() and ($1::timestamptz is null or (next_check_at,id)>($1,$2::uuid)) order by next_check_at,id limit $3",
        [after?.at ?? null, after?.id ?? null, limit],
      );
      let advanced = 0;
      for (const candidate of candidates.rows) {
        signal?.throwIfAborted();
        if (
          await withTenantScopedClient(
            writes.pool,
            {
              workspaceId: candidate.workspace_id,
              actorId: candidate.started_by,
            },
            (client) => advanceSuite(client, candidate),
            {
              ...(signal === undefined ? {} : { signal }),
              statementTimeoutMillis: 2000,
            },
          )
        )
          advanced++;
        after = { at: candidate.next_check_at, id: candidate.id };
      }
      if (candidates.rows.length < limit) after = undefined;
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
