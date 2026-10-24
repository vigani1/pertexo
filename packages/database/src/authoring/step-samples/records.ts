import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import {
  parseWorkflowGraphDraft,
  stepSampleBindings,
} from '@pertexo/workflow-model';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../platform/stored-execution-value.js';
import { collectArtifactReferences } from '../../artifacts/references/repository.js';
import {
  WorkflowStepSampleError,
  type SampleMetadata,
  type SampleMetadataRow,
  type SampleScope,
} from './contract.js';

export async function sampleDraft(
  client: PoolClient,
  input: SampleScope,
  { write }: Readonly<{ write: boolean }>,
) {
  const workflow = await client.query<{ lifecycle_status: string }>(
    'select lifecycle_status from app.workflows where workspace_id=$1 and id=$2 for share',
    [input.workspaceId, input.workflowId],
  );
  const workflowUnavailable =
    workflow.rows[0] === undefined ||
    (write && workflow.rows[0].lifecycle_status !== 'active');
  if (workflowUnavailable)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const result = await client.query<{ revision: number; graph_json: unknown }>(
    `select revision,graph_json from app.workflow_drafts where workspace_id=$1 and workflow_id=$2 for ${write ? 'update' : 'share'}`,
    [input.workspaceId, input.workflowId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const graph = parseWorkflowGraphDraft(row.graph_json);
  return {
    revision: row.revision,
    graph,
    bindings: stepSampleBindings(graph),
  };
}
export async function sampleDatabaseTime(client: PoolClient): Promise<Date> {
  const result = await client.query<{ now: Date }>(
    'select clock_timestamp() now',
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Sample database time is unavailable');
  return row.now;
}
export function sampleMetadata(
  row: SampleMetadataRow,
  binding: string | undefined,
  now: Date,
): SampleMetadata {
  const state = sampleState(row, binding, now);
  return {
    id: row.id,
    nodeId: row.node_id,
    binding: state === 'expired' ? '' : row.binding,
    state,
    source: sampleProvenance(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
function requiredSourceId(id: string | null): string {
  if (id === null) throw new Error('Sample provenance is incomplete');
  return id;
}
export function inlineSampleOutput(output: unknown): string {
  let parsed;
  try {
    parsed = parseStoredExecutionValue(output);
  } catch {
    throw new WorkflowStepSampleError('value_invalid');
  }
  if (
    parsed.kind !== 'inline' ||
    collectArtifactReferences(parsed.value).length > 0
  )
    throw new WorkflowStepSampleError('file_output');
  return serializeStoredExecutionValue(parsed);
}

export async function pruneStepSamples(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  graph: WorkflowGraph,
): Promise<void> {
  await client.query(
    'delete from app.workflow_step_samples where workspace_id=$1 and workflow_id=$2 and not (node_id=any($3::text[]))',
    [workspaceId, workflowId, [...stepSampleBindings(graph).keys()]],
  );
}

function sampleState(
  row: SampleMetadataRow,
  binding: string | undefined,
  now: Date,
): SampleMetadata['state'] {
  if (row.expires_at <= now) {
    return 'expired';
  }
  if (binding !== row.binding) {
    return 'stale';
  }
  return 'pinned';
}

function sampleProvenance(row: SampleMetadataRow): SampleMetadata['source'] {
  if (row.source_kind === 'json' || row.source_kind === 'webhook_test') {
    return { kind: row.source_kind };
  }
  if (row.source_kind === 'preview') {
    return {
      kind: 'preview',
      previewRunId: requiredSourceId(row.source_preview_id),
    };
  }
  return {
    kind: 'run',
    runId: requiredSourceId(row.source_run_id),
    nodeRunId: requiredSourceId(row.source_node_run_id),
  };
}
