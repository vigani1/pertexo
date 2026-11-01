import { and, eq, notInArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowDrafts,
  workflowStepSamples,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../runs/values/stored-execution.js';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import {
  parseWorkflowGraphDraft,
  stepSampleBindings,
} from '@pertexo/workflow-model';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { collectArtifactReferences } from '../../artifacts/references/locks.repository.js';
import { WorkflowStepSampleError } from './errors.js';
import type {
  SampleMetadata,
  SampleMetadataRow,
  SampleScope,
} from './contract.js';

export const sampleMetadataProjection = {
  id: workflowStepSamples.id,
  nodeId: workflowStepSamples.nodeId,
  binding: workflowStepSamples.binding,
  sourceKind: workflowStepSamples.sourceKind,
  sourceRunId: workflowStepSamples.sourceRunId,
  sourceNodeRunId: workflowStepSamples.sourceNodeRunId,
  sourcePreviewId: workflowStepSamples.sourcePreviewId,
  createdAt: workflowStepSamples.createdAt,
  expiresAt: workflowStepSamples.expiresAt,
};
export const sampleProjection = {
  ...sampleMetadataProjection,
  outputRef: workflowStepSamples.outputRef,
  retainedBytes: workflowStepSamples.retainedBytes,
};

export async function sampleDraft(
  client: PoolClient,
  input: SampleScope,
  { write }: Readonly<{ write: boolean }>,
) {
  const db = drizzle(client);
  const [workflow] = await db
    .select({ lifecycleStatus: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  const workflowUnavailable =
    workflow === undefined || (write && workflow.lifecycleStatus !== 'active');
  if (workflowUnavailable)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const [row] = await db
    .select({
      revision: workflowDrafts.revision,
      graphJson: workflowDrafts.graphJson,
    })
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
      ),
    )
    .for(write ? 'update' : 'share')
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const graph = parseWorkflowGraphDraft(row.graphJson);
  return {
    revision: row.revision,
    graph,
    bindings: stepSampleBindings(graph),
  };
}
export async function sampleDatabaseTime(client: PoolClient): Promise<Date> {
  const result = await drizzle(client)
    .execute<{ now: string }>(sql`select clock_timestamp() now`)
    .catch(rethrowQueryFailure);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Sample database time is unavailable');
  return new Date(row.now);
}
export function sampleMetadata(
  row: SampleMetadataRow,
  binding: string | undefined,
  now: Date,
): SampleMetadata {
  const state = sampleState(row, binding, now);
  return {
    id: row.id,
    nodeId: row.nodeId,
    binding: state === 'expired' ? '' : row.binding,
    state,
    source: sampleProvenance(row),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
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
  await drizzle(client)
    .delete(workflowStepSamples)
    .where(
      and(
        eq(workflowStepSamples.workspaceId, workspaceId),
        eq(workflowStepSamples.workflowId, workflowId),
        notInArray(workflowStepSamples.nodeId, [
          ...stepSampleBindings(graph).keys(),
        ]),
      ),
    )
    .catch(rethrowQueryFailure);
}

function sampleState(
  row: SampleMetadataRow,
  binding: string | undefined,
  now: Date,
): SampleMetadata['state'] {
  if (row.expiresAt <= now) {
    return 'expired';
  }
  if (binding !== row.binding) {
    return 'stale';
  }
  return 'pinned';
}

function sampleProvenance(row: SampleMetadataRow): SampleMetadata['source'] {
  if (row.sourceKind === 'json' || row.sourceKind === 'webhook_test') {
    return { kind: row.sourceKind };
  }
  if (row.sourceKind === 'preview') {
    return {
      kind: 'preview',
      previewRunId: requiredSourceId(row.sourcePreviewId),
    };
  }
  return {
    kind: 'run',
    runId: requiredSourceId(row.sourceRunId),
    nodeRunId: requiredSourceId(row.sourceNodeRunId),
  };
}
