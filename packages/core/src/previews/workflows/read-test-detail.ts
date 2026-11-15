import type { PoolClient } from 'pg';
import type { WorkflowActor } from '../../shared/workflow-actor.types.js';
import { WorkflowTestError } from './workflow-test.errors.js';
import type { WorkflowTestDetail } from './workflow-test.types.js';
import { readTestDetailRow, summary } from './workflow-tests.repository.js';

export async function readTestDetail(
  client: PoolClient,
  input: WorkflowActor & { runId: string },
): Promise<WorkflowTestDetail> {
  const row = await readTestDetailRow(client, input);
  if (row === undefined) throw new WorkflowTestError('not_found');
  return {
    ...summary(row),
    graph: row.graphJson,
    dispositions: row.dispositions,
  };
}
