import { and, eq } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { workflowVersions } from '../../../schema/authoring/workflows.js';
import { workflowTestSnapshots } from '../../../schema/runs/tests.js';
import type { FrozenWorkflowTestPins } from '../../../schema/runs/tests.js';
import { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';

import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import type { DatabaseConfig } from '../../../config.js';
import { withWorkspaceReadTransaction } from '../../../tenant-access/transactions.js';
import { sql } from 'drizzle-orm';
import type {
  WorkflowTestPolicy,
  WorkflowTestPins,
} from '@pertexo/workflow-engine';
import type {
  PublishedWorkflowReader,
  PublishedWorkflow,
} from './published.queries.js';

export type WorkflowExecutionProjection = PublishedWorkflow &
  Readonly<{
    testExpiresAt?: Date;
    testSample?: WorkflowTestPins[string];
    test?: WorkflowTestPolicy;
  }>;
export interface WorkflowExecutionReader extends Omit<
  PublishedWorkflowReader,
  'readForExecution'
> {
  readForExecution(
    input: Parameters<PublishedWorkflowReader['readForExecution']>[0] &
      Readonly<{ nodeId?: string }>,
  ): Promise<WorkflowExecutionProjection | null>;
}
/** Both sources are immutable; a test snapshot never enters publication queries. */
const sourceBuilder = new QueryBuilder();
export const EXECUTION_SOURCE_SQL = sourceBuilder
  .select({
    id: workflowVersions.id,
    workspace_id: workflowVersions.workspaceId,
    workflow_id: workflowVersions.workflowId,
    version_number: workflowVersions.versionNumber,
    checksum: workflowVersions.checksum,
    executable_json: workflowVersions.executableJson,
    test_dispositions: sql<
      typeof workflowTestSnapshots.$inferSelect.dispositions | null
    >`null::jsonb`.as('test_dispositions'),
    test_expires_at: sql<Date | null>`null::timestamptz`
      .mapWith(workflowTestSnapshots.expiresAt)
      .as('test_expires_at'),
  })
  .from(workflowVersions)
  .unionAll(
    sourceBuilder
      .select({
        id: workflowTestSnapshots.id,
        workspace_id: workflowTestSnapshots.workspaceId,
        workflow_id: workflowTestSnapshots.workflowId,
        version_number: workflowTestSnapshots.draftRevision,
        checksum: workflowTestSnapshots.checksum,
        executable_json: workflowTestSnapshots.executableJson,
        test_dispositions: workflowTestSnapshots.dispositions,
        test_expires_at: workflowTestSnapshots.expiresAt,
      })
      .from(workflowTestSnapshots),
  )
  .as('version');

function executionSourceQuery(db: Pick<NodePgDatabase, 'select'>) {
  return db.select().from(EXECUTION_SOURCE_SQL);
}
type SourceRow = Awaited<ReturnType<typeof executionSourceQuery>>[number];
// The UNION's test branch selects both fields from the same immutable snapshot.
function isTestSource(row: SourceRow): row is SourceRow & {
  test_dispositions: NonNullable<SourceRow['test_dispositions']>;
  test_expires_at: Date;
} {
  return row.test_dispositions !== null;
}
export function projectExecutionSource(
  row: SourceRow | undefined,
): WorkflowExecutionProjection | null {
  if (row === undefined) return null;
  const version = {
    checksum: row.checksum,
    executableJson: row.executable_json,
    id: row.id,
    versionNumber: row.version_number,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
  };
  if (!isTestSource(row)) return version;
  return {
    ...version,
    testExpiresAt: row.test_expires_at,
    test: {
      pinnedNodeIds: Object.entries(row.test_dispositions)
        .filter(([, kind]) => kind === 'pinned')
        .map(([nodeId]) => nodeId),
    },
  };
}
export function createWorkflowExecutionReader(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkflowExecutionReader {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    readForExecution: (input) =>
      withWorkspaceReadTransaction(
        lease.pool,
        input.workspaceId,
        async (transaction) => {
          const rows = await executionSourceQuery(transaction.db)
            .where(
              and(
                eq(EXECUTION_SOURCE_SQL.workspace_id, input.workspaceId),
                eq(EXECUTION_SOURCE_SQL.id, input.workflowVersionId),
              ),
            )
            .limit(1);
          const projection = projectExecutionSource(rows[0]);
          const sampleUnavailable =
            projection === null ||
            input.nodeId === undefined ||
            !projection.test?.pinnedNodeIds.includes(input.nodeId);
          if (sampleUnavailable) return projection;
          const [pin] = await transaction.db
            .select({
              sample: sql<
                FrozenWorkflowTestPins[string] | null
              >`${workflowTestSnapshots.pins}->${input.nodeId}::text`,
            })
            .from(workflowTestSnapshots)
            .where(
              and(
                eq(workflowTestSnapshots.workspaceId, input.workspaceId),
                eq(workflowTestSnapshots.id, input.workflowVersionId),
              ),
            );
          const sample = pin?.sample;
          if (sample === undefined || sample === null)
            throw new Error('Frozen test sample is unavailable');
          const output = parseStoredExecutionValue(sample.outputRef);
          if (output.kind !== 'inline')
            throw new Error('Frozen test sample is unavailable');
          return {
            ...projection,
            testSample: { sampleId: sample.sampleId, output: output.value },
          };
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
  };
}
