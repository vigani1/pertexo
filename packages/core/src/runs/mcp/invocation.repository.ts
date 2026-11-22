import { and, eq, isNull, sql } from 'drizzle-orm';
import { workflowRuns } from '@pertexo/database/schema';
import { expiredRunSql } from '../../shared/run-records/run-retention.repository.js';
import type { ResourceTransaction } from '../../shared/access/folder-access.types.js';
import { workflowScopeSql } from '../../shared/access/folder-scope.repository.js';

export function readMcpInvocation(
  transaction: ResourceTransaction,
  input: Readonly<{ runId: string; tokenId: string; referenceDigest: string }>,
) {
  const run = workflowRuns;
  return transaction.db
    .select({
      workflowId: run.workflowId,
      versionId: run.workflowVersionId,
      status: run.status,
      result: run.outputRef,
      revision: sql<string>`${run.mcpInvocation}->>'exposureRevision'`,
    })
    .from(run)
    .where(
      and(
        eq(run.workspaceId, transaction.workspaceId),
        eq(run.id, input.runId),
        sql`${run.mcpInvocation}->>'tokenId'=${input.tokenId}`,
        sql`${run.mcpInvocation}->>'referenceDigest'=${input.referenceDigest}`,
        isNull(run.detailsPurgedAt),
        sql`not (${expiredRunSql('workflow_runs')})`,
        workflowScopeSql(
          transaction.resources,
          sql`${run.workflowId}`,
          'run:start',
        ),
      ),
    )
    .limit(1)
    .then(([row]) => row);
}
