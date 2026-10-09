import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';
import { strongEtagSchema, workflowGraphSchema } from '@pertexo/contracts';

/** Bounded test-control evidence; never authentication credentials or source logs. */
export const expressionAdmissionEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  loopId: z.uuid(),
  leafId: z.uuid(),
  runId: z.uuid(),
  publishKey: z.uuid(),
  runKey: z.uuid(),
  invalidRevision: z.number().int().positive(),
  correctedRevision: z.number().int().positive(),
  checkedEtag: strongEtagSchema,
});

export async function verifyExpressionAdmissionEvidence(
  database: Pool,
  evidence: z.infer<typeof expressionAdmissionEvidenceSchema>,
) {
  const versions = await database.query<{ id: string; graph_json: unknown }>(
    'select id,graph_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(versions.rows).toHaveLength(1);
  expect(versions.rows[0]?.id).toBe(evidence.workflowVersionId);
  const graph = workflowGraphSchema.parse(versions.rows[0]?.graph_json);
  expect(graph.nodes).toHaveLength(1);
  const loop = graph.nodes[0];
  expect(loop).toMatchObject({
    id: evidence.loopId,
    structured: { maxIterations: 2, maxConcurrency: 1 },
    inputMappings: { items: { kind: 'run_input', path: '$.items' } },
  });
  expect(loop?.structured?.body.nodes).toHaveLength(1);
  expect(loop?.structured?.body.nodes[0]).toMatchObject({
    id: evidence.leafId,
    inputMappings: {
      item: { kind: 'structured_input', port: 'item', path: '$' },
      expressionProof: {
        kind: 'expression',
        language: 'jsonata',
        expression: 'runInput.amount > 5000',
        policyVersion: 1,
      },
    },
  });
  const draft = await database.query<{ revision: number; graph_json: unknown }>(
    'select revision,graph_json from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(draft.rows).toHaveLength(1);
  expect(draft.rows[0]?.revision).toBe(evidence.correctedRevision);
  expect(evidence.correctedRevision).toBeGreaterThan(evidence.invalidRevision);
  expect(workflowGraphSchema.parse(draft.rows[0]?.graph_json)).toEqual(graph);
  const runs = await database.query<{
    id: string;
    status: string;
    workflow_version_id: string;
  }>(
    'select id,status,workflow_version_id from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(runs.rows).toEqual([
    {
      id: evidence.runId,
      status: 'succeeded',
      workflow_version_id: evidence.workflowVersionId,
    },
  ]);
  const nodes = await database.query<{
    node_id: string;
    status: string;
    input_ref: unknown;
    output_ref: unknown;
  }>(
    'select node_id,status,input_ref,output_ref from app.node_runs where workspace_id=$1 and workflow_run_id=$2',
    [evidence.workspaceId, evidence.runId],
  );
  expect(nodes.rows).toHaveLength(2);
  expect(nodes.rows.every((node) => node.status === 'succeeded')).toBe(true);
  expect(nodes.rows.map((node) => node.node_id).sort()).toEqual(
    [evidence.loopId, evidence.leafId].sort(),
  );
  const leaf = nodes.rows.find((node) => node.node_id === evidence.leafId);
  const expectedPayload = {
    kind: 'inline',
    value: { item: 'north', expressionProof: true },
  };
  expect(leaf?.input_ref).toMatchObject(expectedPayload);
  expect(leaf?.output_ref).toMatchObject(expectedPayload);
  const receipts = await database.query<{
    operation: string;
    status: string;
    key_hash: string;
    resource_id: string;
  }>(
    `select operation,status,key_hash,resource_id from app.idempotency_records where workspace_id=$1
     and resource_id=any($2::uuid[]) and operation in ('workflow.publish','workflow.run.accept') order by operation`,
    [evidence.workspaceId, [evidence.workflowId, evidence.runId]],
  );
  expect(receipts.rows).toEqual([
    {
      operation: 'workflow.publish',
      status: 'completed',
      key_hash: createHash('sha256').update(evidence.publishKey).digest('hex'),
      resource_id: evidence.workflowId,
    },
    {
      operation: 'workflow.run.accept',
      status: 'completed',
      key_hash: createHash('sha256').update(evidence.runKey).digest('hex'),
      resource_id: evidence.runId,
    },
  ]);
  const audits = await database.query<{ action: string; count: number }>(
    `select action,count(*)::int as count from app.audit_events where workspace_id=$1 and target_id=any($2::uuid[])
     and action in ('workflow.published','workflow.run.started') group by action order by action`,
    [evidence.workspaceId, [evidence.workflowId, evidence.runId]],
  );
  expect(audits.rows).toEqual([
    { action: 'workflow.published', count: 1 },
    { action: 'workflow.run.started', count: 1 },
  ]);
}
