import type { FrozenWorkflowTestPins } from '../../schema/runs/tests.js';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { z } from 'zod';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import type { DatabaseConfig } from '../../config.js';
import { withWorkspaceReadTransaction } from '../../tenant-access/transactions.js';
import { sql } from 'drizzle-orm';
import type {
  WorkflowTestPolicy,
  WorkflowTestPins,
} from '@pertexo/workflow-engine';
import {
  parsePublishedWorkflowRow,
  type PublishedWorkflowReader,
  type PublishedWorkflow,
} from './published-workflow.js';

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
export const EXECUTION_SOURCE_SQL = `select id,workspace_id,workflow_id,version_number,checksum,executable_json,null::jsonb test_dispositions,null::timestamptz test_expires_at from app.workflow_versions
 union all select snapshot.run_id,snapshot.workspace_id,run.workflow_id,snapshot.draft_revision,snapshot.checksum,snapshot.executable_json,snapshot.dispositions,snapshot.expires_at
 from app.workflow_test_snapshots snapshot join app.workflow_runs run on run.workspace_id=snapshot.workspace_id and run.id=snapshot.run_id
 where run.trigger_type='test'`;

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
          const rows = await transaction.db.execute(
            sql`select * from (${sql.raw(EXECUTION_SOURCE_SQL)}) source where workspace_id=${input.workspaceId} and id=${input.workflowVersionId} limit 1`,
          );
          const projection = parseExecutionSource(rows.rows[0]);
          if (
            projection === null ||
            input.nodeId === undefined ||
            !projection.test?.pinnedNodeIds.includes(input.nodeId)
          )
            return projection;
          const pin = await transaction.db.execute<{
            sample: FrozenWorkflowTestPins[string] | null;
          }>(
            sql`select pins -> ${input.nodeId}::text sample from app.workflow_test_snapshots where workspace_id=${input.workspaceId} and run_id=${input.workflowVersionId}`,
          );
          const sample = pin.rows[0]?.sample;
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
