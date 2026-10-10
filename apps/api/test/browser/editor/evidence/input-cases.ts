import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';
import { workflowGraphSchema } from '@pertexo/contracts';

/** Identity-only evidence; never keys, tags, payloads, names or session material. */
export const workflowInputCasesEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  caseId: z.uuid(),
  replacementCaseId: z.uuid(),
  runId: z.uuid(),
  workflowVersionId: z.uuid(),
  nodeId: z.uuid(),
  originalWorkflowVersionId: z.uuid(),
  currentPublishedVersionId: z.uuid(),
});

/** Verify durable ordinary case/admission/worker facts, not browser assertions alone. */
export async function verifyWorkflowInputCasesEvidence(
  database: Pool,
  evidence: z.infer<typeof workflowInputCasesEvidenceSchema>,
) {
  expect(evidence.caseId).not.toBe(evidence.replacementCaseId);
  expect(
    new Set([
      evidence.originalWorkflowVersionId,
      evidence.workflowVersionId,
      evidence.currentPublishedVersionId,
    ]).size,
  ).toBe(3);
  const workflows = await database.query<{ published_version_id: string }>(
    'select published_version_id from app.workflows where workspace_id=$1 and id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(workflows.rows).toEqual([
    { published_version_id: evidence.currentPublishedVersionId },
  ]);
  const versions = await database.query<{
    id: string;
    checksum: string;
    graph_json: unknown;
  }>(
    'select id,checksum,graph_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2 order by version_number limit 4',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(versions.rows.map((row) => row.id)).toEqual([
    evidence.originalWorkflowVersionId,
    evidence.workflowVersionId,
    evidence.currentPublishedVersionId,
  ]);
  const graph = workflowGraphSchema.parse(versions.rows[1]?.graph_json);
  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]).toMatchObject({
    id: evidence.nodeId,
    inputMappings: { proof: { kind: 'run_input', path: '$.proof' } },
  });
  const cases = await database.query<{
    id: string;
    workflow_version_id: string;
    version_checksum: string;
    revision: number;
    deleted_at: Date | null;
  }>(
    'select id,workflow_version_id,version_checksum,revision,deleted_at from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2 order by created_at,id limit 3',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(cases.rows).toHaveLength(2);
  const original = cases.rows.find((row) => row.id === evidence.caseId);
  const replacement = cases.rows.find(
    (row) => row.id === evidence.replacementCaseId,
  );
  expect(original).toMatchObject({
    workflow_version_id: evidence.originalWorkflowVersionId,
    version_checksum: versions.rows[0]?.checksum,
    revision: 4,
  });
  expect(original?.deleted_at).toBeInstanceOf(Date);
  expect(replacement).toMatchObject({
    workflow_version_id: evidence.workflowVersionId,
    version_checksum: versions.rows[1]?.checksum,
    revision: 1,
    deleted_at: null,
  });
  const payloads = await database.query<{
    case_id: string;
    revision: number;
    input: string;
    canonical_bytes: number;
  }>(
    'select case_id,revision,input,canonical_bytes from app.workflow_input_case_payloads where workspace_id=$1 and case_id=any($2::uuid[]) order by case_id,revision limit 4',
    [evidence.workspaceId, [evidence.caseId, evidence.replacementCaseId]],
  );
  const first = payloads.rows.find(
    (row) => row.case_id === evidence.caseId && row.revision === 1,
  );
  const edited = payloads.rows.find(
    (row) => row.case_id === evidence.caseId && row.revision === 2,
  );
  const copied = payloads.rows.find(
    (row) => row.case_id === evidence.replacementCaseId && row.revision === 1,
  );
  expect(first).toBeDefined();
  expect(edited).toBeDefined();
  expect(copied).toBeDefined();
  const expectedInput = { proof: 'f02-real-input' };
  expect(JSON.parse(first?.input ?? '') as unknown).toEqual(expectedInput);
  expect(JSON.parse(edited?.input ?? '') as unknown).toEqual(expectedInput);
  expect(JSON.parse(copied?.input ?? '') as unknown).toEqual(expectedInput);
  for (const payload of payloads.rows)
    expect(payload.canonical_bytes).toBe(
      Buffer.byteLength(payload.input, 'utf8'),
    );
  const runs = await database.query<{
    id: string;
    workflow_version_id: string;
    status: string;
    trigger_type: string;
    input_ref: unknown;
  }>(
    'select id,workflow_version_id,status,trigger_type,input_ref from app.workflow_runs where workspace_id=$1 and workflow_id=$2 limit 2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(runs.rows).toHaveLength(1);
  expect(runs.rows[0]).toMatchObject({
    id: evidence.runId,
    workflow_version_id: evidence.workflowVersionId,
    status: 'succeeded',
    trigger_type: 'manual',
    input_ref: {
      kind: 'inline',
      value: expectedInput,
    },
  });
  const nodes = await database.query<{
    node_id: string;
    status: string;
    input_ref: unknown;
    output_ref: unknown;
    current_attempt_number: number;
  }>(
    'select node_id,status,input_ref,output_ref,current_attempt_number from app.node_runs where workspace_id=$1 and workflow_run_id=$2 limit 2',
    [evidence.workspaceId, evidence.runId],
  );
  expect(nodes.rows).toHaveLength(1);
  expect(nodes.rows[0]).toMatchObject({
    node_id: evidence.nodeId,
    status: 'succeeded',
    current_attempt_number: 1,
    input_ref: {
      kind: 'inline',
      value: expectedInput,
    },
    output_ref: {
      kind: 'inline',
      value: expectedInput,
    },
  });
  const rejected = await database.query<{
    expected_version_id: string;
    observed_version_id: string;
  }>(
    'select expected_version_id,observed_version_id from app.workflow_manual_start_rejections where workspace_id=$1 and workflow_id=$2 limit 2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(rejected.rows).toEqual([
    {
      expected_version_id: evidence.originalWorkflowVersionId,
      observed_version_id: evidence.workflowVersionId,
    },
  ]);
  const accepted = await database.query<{
    status: string;
    resource_id: string;
  }>(
    "select status,resource_id from app.idempotency_records where workspace_id=$1 and scope=$2 and operation='workflow.run.accept' limit 2",
    [evidence.workspaceId, `workflow:${evidence.workflowId}:manual`],
  );
  expect(accepted.rows).toEqual([
    { status: 'completed', resource_id: evidence.runId },
  ]);
  const receipts = await database.query<{
    operation: string;
    case_id: string;
    revision: number;
  }>(
    `select substring(operation from 'workflow\\.inputcase\\.(.*)') operation,
            resource_id case_id, (result_ref->>'revision')::int revision
     from app.idempotency_records
     where workspace_id=$1 and operation like 'workflow.inputcase.%'
       and scope like '%:' || $2
     order by resource_id, revision limit 6`,
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(receipts.rows).toHaveLength(5);
  expect(receipts.rows).toEqual(
    expect.arrayContaining([
      { operation: 'create', case_id: evidence.caseId, revision: 1 },
      { operation: 'update', case_id: evidence.caseId, revision: 2 },
      { operation: 'update', case_id: evidence.caseId, revision: 3 },
      { operation: 'delete', case_id: evidence.caseId, revision: 4 },
      { operation: 'create', case_id: evidence.replacementCaseId, revision: 1 },
    ]),
  );
  const audits = await database.query<{ target_id: string; metadata: unknown }>(
    "select target_id,metadata from app.audit_events where workspace_id=$1 and target_type='workflow_input_case' limit 6",
    [evidence.workspaceId],
  );
  expect(audits.rows).toHaveLength(5);
  for (const audit of audits.rows)
    expect(
      Object.keys(
        z.record(z.string(), z.unknown()).parse(audit.metadata),
      ).sort(),
    ).toEqual(['revision', 'workflowId']);
}
