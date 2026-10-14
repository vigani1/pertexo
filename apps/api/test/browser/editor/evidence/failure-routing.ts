import { expect } from 'vitest';
import { z } from 'zod';
import type { Pool } from 'pg';
import { workflowGraphSchema } from '@pertexo/contracts';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  composeExecutableCatalog,
  verifyWorkflowExecutable,
} from '@pertexo/workflow-engine';
import type { httpEffectsSchema } from './http.js';
export const failureRoutingEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  handledRunId: z.uuid(),
  unknownRunId: z.uuid(),
  sourceId: z.string(),
  handlerId: z.string(),
  normalStopId: z.string(),
});
export async function verifyFailureRoutingEvidence(
  database: Pool,
  evidence: z.infer<typeof failureRoutingEvidenceSchema>,
  effects: z.infer<typeof httpEffectsSchema>,
) {
  const version = (
    await database.query<{
      graph_json: unknown;
      executable_json: unknown;
      checksum: string;
    }>(
      'select graph_json,executable_json,checksum from app.workflow_versions where workspace_id=$1 and id=$2',
      [evidence.workspaceId, evidence.workflowVersionId],
    )
  ).rows[0];
  if (version === undefined)
    throw new Error('Browser-authored failure version missing');
  verifyWorkflowExecutable({
    envelope: version.executable_json,
    checksum: version.checksum,
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
  });
  const graph = workflowGraphSchema.parse(version.graph_json);
  expect(
    graph.edges.find(
      (edge) =>
        edge.source.nodeId === evidence.sourceId &&
        edge.source.port === '__failure',
    )?.target.nodeId,
  ).toBe(evidence.handlerId);
  expect(
    graph.nodes.find((node) => node.id === evidence.handlerId)?.inputMappings,
  ).toEqual({
    failure: { kind: 'node_failure', nodeId: evidence.sourceId, path: '$' },
  });
  const runs = await database.query<{
    id: string;
    status: string;
    handled_failure_count: number;
  }>(
    'select id,status,handled_failure_count from app.workflow_runs where workspace_id=$1 and id=any($2::uuid[])',
    [evidence.workspaceId, [evidence.handledRunId, evidence.unknownRunId]],
  );
  expect(
    runs.rows.find((run) => run.id === evidence.handledRunId),
  ).toMatchObject({ status: 'succeeded', handled_failure_count: 1 });
  expect(
    runs.rows.find((run) => run.id === evidence.unknownRunId),
  ).toMatchObject({ status: 'outcome_unknown', handled_failure_count: 0 });
  const nodes = await database.query<{
    workflow_run_id: string;
    node_id: string;
    status: string;
    failure_ref: unknown;
    failure_handling: string | null;
    branch_context: unknown;
    input_ref: unknown;
  }>(
    'select workflow_run_id,node_id,status,failure_ref,failure_handling,branch_context,input_ref from app.node_runs where workspace_id=$1 and workflow_run_id=any($2::uuid[])',
    [evidence.workspaceId, [evidence.handledRunId, evidence.unknownRunId]],
  );
  const source = nodes.rows.find(
    (node) =>
      node.workflow_run_id === evidence.handledRunId &&
      node.node_id === evidence.sourceId,
  );
  const handler = nodes.rows.find(
    (node) =>
      node.workflow_run_id === evidence.handledRunId &&
      node.node_id === evidence.handlerId,
  );
  expect(source).toMatchObject({
    status: 'failed',
    failure_handling: 'handled',
  });
  expect(handler).toMatchObject({
    status: 'succeeded',
    branch_context: source?.branch_context,
  });
  const value = z
    .object({
      kind: z.literal('inline'),
      value: z.record(z.string(), z.unknown()),
    })
    .parse(source?.failure_ref);
  expect(value.kind).toBe('inline');
  expect(value.value).toMatchObject({
    nodeId: evidence.sourceId,
    attemptNumber: 1,
    errorKind: 'authentication',
    safeErrorCode: 'execution.authentication',
  });
  expect(Object.keys(value.value).sort()).toEqual([
    'attemptNumber',
    'errorKind',
    'invocationKey',
    'nodeId',
    'safeErrorCode',
  ]);
  expect(handler?.input_ref).toEqual({
    kind: 'inline',
    value: { failure: value.value },
  });
  expect(
    nodes.rows.find(
      (node) =>
        node.workflow_run_id === evidence.handledRunId &&
        node.node_id === evidence.normalStopId,
    )?.status,
  ).toBe('skipped');
  expect(
    nodes.rows.find(
      (node) =>
        node.workflow_run_id === evidence.unknownRunId &&
        node.node_id === evidence.sourceId,
    )?.failure_handling,
  ).toBeNull();
  expect(
    nodes.rows.find(
      (node) =>
        node.workflow_run_id === evidence.unknownRunId &&
        node.node_id === evidence.handlerId,
    )?.status,
  ).toBe('skipped');
  const events = await database.query<{ type: string }>(
    'select type from app.run_events where workspace_id=$1 and workflow_run_id=$2',
    [evidence.workspaceId, evidence.handledRunId],
  );
  expect(
    events.rows.filter((e) => e.type === 'node.failure_routed'),
  ).toHaveLength(1);
  expect(
    events.rows.filter((e) => e.type === 'node.failure_handled'),
  ).toHaveLength(1);
  const inbox = await database.query<{ count: number }>(
    'select count(*)::int count from app.workspace_inbox_events where workspace_id=$1 and run_id=$2',
    [evidence.workspaceId, evidence.handledRunId],
  );
  expect(inbox.rows[0]?.count).toBe(0);
  expect(effects).toMatchObject({
    phase: 'controlled-http-effects',
    requests: 2,
    effects: 1,
  });
}
