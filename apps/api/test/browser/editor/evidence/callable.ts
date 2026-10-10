import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';
import { workflowGraphSchema } from '@pertexo/contracts';

export const callableEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  successRunId: z.uuid(),
  failedRunId: z.uuid(),
  successVersionId: z.uuid(),
  failedVersionId: z.uuid(),
});

export async function verifyCallableEvidence(
  database: Pool,
  evidence: z.infer<typeof callableEvidenceSchema>,
) {
  const values = [evidence.workspaceId, evidence.workflowId];
  const versions = await database.query<{
    id: string;
    graph_json: unknown;
    executable_json: { graph: unknown };
  }>(
    'select id,graph_json,executable_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2 order by version_number',
    values,
  );
  expect(versions.rows.map(({ id }) => id)).toEqual([
    evidence.successVersionId,
    evidence.failedVersionId,
  ]);
  for (const version of versions.rows) {
    const graph = workflowGraphSchema.parse(version.graph_json);
    expect(graph.callable?.input).toEqual({
      type: 'object',
      properties: [
        { name: 'customer', required: true, valueType: { type: 'string' } },
      ],
    });
    expect(version.executable_json.graph).toMatchObject({
      callable: graph.callable,
    });
  }
  const runs = await database.query<{
    id: string;
    status: string;
    output_ref: unknown;
    error_summary: string | null;
  }>(
    'select id,status,output_ref,error_summary from app.workflow_runs where workspace_id=$1 and workflow_id=$2 order by created_at,id',
    values,
  );
  expect(runs.rows).toEqual([
    {
      id: evidence.successRunId,
      status: 'succeeded',
      output_ref: { kind: 'inline', value: 'Ada' },
      error_summary: null,
    },
    {
      id: evidence.failedRunId,
      status: 'failed',
      output_ref: null,
      error_summary: 'callable_result_missing',
    },
  ]);
  const terminal = await database.query<{
    workflow_run_id: string;
    type: string;
    payload: unknown;
  }>(
    "select workflow_run_id,type,payload from app.run_events where workspace_id=$1 and workflow_run_id=any($2::uuid[]) and type in ('run.failed','run.succeeded') order by workflow_run_id",
    [evidence.workspaceId, [evidence.successRunId, evidence.failedRunId]],
  );
  expect(terminal.rows).toHaveLength(2);
  expect(
    terminal.rows.find(
      ({ workflow_run_id }) => workflow_run_id === evidence.failedRunId,
    ),
  ).toMatchObject({
    type: 'run.failed',
    payload: { reasonCode: 'callable_result_missing' },
  });
  const nodes = await database.query<{ status: string }>(
    'select status from app.node_runs where workspace_id=$1 and workflow_run_id=any($2::uuid[])',
    [evidence.workspaceId, [evidence.successRunId, evidence.failedRunId]],
  );
  expect(nodes.rows).toEqual([
    { status: 'succeeded' },
    { status: 'succeeded' },
  ]);
}
