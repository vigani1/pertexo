import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';
import { workflowGraphSchema } from '@pertexo/contracts';

/** Identity-only fixture receipt; source graphs, keys and tags stay out of logs. */
export const workflowDuplicationEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  sourceWorkflowId: z.uuid(),
  draftCopyId: z.uuid(),
  versionCopyId: z.uuid(),
  sourceVersionId: z.uuid(),
  draftCopyVersionId: z.uuid(),
  versionCopyVersionId: z.uuid(),
  sourceRunId: z.uuid(),
  draftCopyRunId: z.uuid(),
  versionCopyRunId: z.uuid(),
  dynamicNodeId: z.uuid(),
});

export async function verifyWorkflowDuplicationEvidence(
  database: Pool,
  evidence: z.infer<typeof workflowDuplicationEvidenceSchema>,
) {
  const workflowIds = [
    evidence.sourceWorkflowId,
    evidence.draftCopyId,
    evidence.versionCopyId,
  ];
  const versionIds = [
    evidence.sourceVersionId,
    evidence.draftCopyVersionId,
    evidence.versionCopyVersionId,
  ];
  const runIds = [
    evidence.sourceRunId,
    evidence.draftCopyRunId,
    evidence.versionCopyRunId,
  ];
  expect(new Set(workflowIds).size).toBe(3);
  expect(new Set(versionIds).size).toBe(3);
  expect(new Set(runIds).size).toBe(3);
  const versions = await database.query<{
    id: string;
    workflow_id: string;
    graph_json: unknown;
  }>(
    'select id,workflow_id,graph_json from app.workflow_versions where workspace_id=$1 and workflow_id=any($2::uuid[])',
    [evidence.workspaceId, workflowIds],
  );
  expect(versions.rows).toHaveLength(3);
  const graphs = versionIds.map((id, index) => {
    const row = versions.rows.find((row) => row.id === id);
    expect(row?.workflow_id).toBe(workflowIds[index]);
    return workflowGraphSchema.parse(row?.graph_json);
  });
  expect(graphs[1]).toEqual(graphs[0]);
  expect(graphs[2]).toEqual(graphs[0]);
  const serializedGraph = JSON.stringify(graphs[0]);
  expect(serializedGraph).toContain(
    '$lookup(nodeOutputs, runInput.stepId).value',
  );
  expect(serializedGraph).toContain(evidence.dynamicNodeId);
  expect(serializedGraph).toContain('core.foreach');
  expect(serializedGraph).toContain('core.parallel');
  expect(serializedGraph).toContain('core.merge');
  const drafts = await database.query<{
    workflow_id: string;
    revision: number;
    graph_json: unknown;
  }>(
    'select workflow_id,revision,graph_json from app.workflow_drafts where workspace_id=$1 and workflow_id=any($2::uuid[])',
    [evidence.workspaceId, workflowIds],
  );
  expect(drafts.rows).toHaveLength(3);
  expect(
    workflowGraphSchema.parse(
      drafts.rows.find((row) => row.workflow_id === evidence.sourceWorkflowId)
        ?.graph_json,
    ),
  ).toEqual(graphs[0]);
  expect(
    workflowGraphSchema.parse(
      drafts.rows.find((row) => row.workflow_id === evidence.versionCopyId)
        ?.graph_json,
    ),
  ).toEqual(graphs[0]);
  const editedCopy = drafts.rows.find(
    (row) => row.workflow_id === evidence.draftCopyId,
  );
  expect(editedCopy?.revision).toBeGreaterThan(1);
  expect(workflowGraphSchema.parse(editedCopy?.graph_json)).not.toEqual(
    graphs[0],
  );
  const runs = await database.query<{
    id: string;
    workflow_id: string;
    workflow_version_id: string;
    status: string;
  }>(
    'select id,workflow_id,workflow_version_id,status from app.workflow_runs where workspace_id=$1 and workflow_id=any($2::uuid[])',
    [evidence.workspaceId, workflowIds],
  );
  expect(runs.rows).toHaveLength(3);
  for (const [index, id] of runIds.entries()) {
    expect(runs.rows.find((row) => row.id === id)).toEqual({
      id,
      workflow_id: workflowIds[index],
      workflow_version_id: versionIds[index],
      status: 'succeeded',
    });
    const outputs = await database.query<{
      status: string;
      output_ref: unknown;
    }>(
      'select status,output_ref from app.node_runs where workspace_id=$1 and workflow_run_id=$2 and node_id=$3',
      [evidence.workspaceId, id, evidence.dynamicNodeId],
    );
    expect(outputs.rows).toHaveLength(1);
    expect(outputs.rows[0]).toMatchObject({
      status: 'succeeded',
      output_ref: {
        kind: 'inline',
        value: {
          value: ['source-marker', 'draft-copy-marker', 'version-copy-marker'][
            index
          ],
        },
      },
    });
  }
  const receipts = await database.query<{
    status: string;
    resource_id: string;
    result_ref: unknown;
  }>(
    "select status,resource_id,result_ref from app.idempotency_records where workspace_id=$1 and operation='workflow.duplicate'",
    [evidence.workspaceId],
  );
  expect(receipts.rows).toHaveLength(2);
  for (const copyId of workflowIds.slice(1))
    expect(receipts.rows.find((row) => row.resource_id === copyId)).toEqual({
      status: 'completed',
      resource_id: copyId,
      result_ref: { workflowId: copyId },
    });
  const audits = await database.query<{ target_id: string; metadata: unknown }>(
    "select target_id,metadata from app.audit_events where workspace_id=$1 and action='workflow.duplicated'",
    [evidence.workspaceId],
  );
  expect(audits.rows).toHaveLength(2);
  for (const copyId of workflowIds.slice(1))
    expect(
      audits.rows.find((row) => row.target_id === copyId)?.metadata,
    ).toMatchObject({
      sourceWorkflowId: evidence.sourceWorkflowId,
      revision: 1,
    });
}
