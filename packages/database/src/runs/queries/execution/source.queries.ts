import { and, eq } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { workflowVersions } from '../../../schema/authoring/workflows.js';
import { workflowTestSnapshots } from '../../../schema/runs/tests.js';
import type { FrozenWorkflowTestPins } from '../../../schema/runs/tests.js';
import { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';
import { z } from 'zod';
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
import {
  parsePublishedWorkflowRow,
  type PublishedWorkflowReader,
  type PublishedWorkflow,
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

export function parseExecutionSource(
  row: Record<string, unknown> | undefined,
): WorkflowExecutionProjection | null {
  if (row === undefined) return null;
  const { test_dispositions, test_expires_at, ...version } = row;
  const parsed = parsePublishedWorkflowRow(version);
  return parsed === null
    ? null
    : {
        ...parsed,
        ...(test_dispositions === null || test_dispositions === undefined
          ? {}
          : {
              testExpiresAt: z.coerce.date().parse(test_expires_at),
              test: {
                pinnedNodeIds: Object.entries(
                  test_dispositions as Record<string, string>,
                )
                  .filter(([, kind]) => kind === 'pinned')
                  .map(([nodeId]) => nodeId),
              },
            }),
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
          const rows = await transaction.db
            .select()
            .from(EXECUTION_SOURCE_SQL)
            .where(
              and(
                eq(EXECUTION_SOURCE_SQL.workspace_id, input.workspaceId),
                eq(EXECUTION_SOURCE_SQL.id, input.workflowVersionId),
              ),
            )
            .limit(1);
          const projection = parseExecutionSource(rows[0]);
          const sampleUnavailable =
            projection === null ||
            input.nodeId === undefined ||
            !projection.test?.pinnedNodeIds.includes(input.nodeId);
          if (sampleUnavailable) return projection;
          const pin = await transaction.db
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
          const sample = pin[0]?.sample;
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
