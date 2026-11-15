import type { WorkflowActor } from '../../shared/workflow-actor.types.js';
import { and, eq, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowDrafts,
  workflowStepSamples,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { stepSampleBindings } from '@pertexo/workflow-model';
import type { SampleMetadata, SampleMetadataRow } from './step-sample.types.js';

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

export async function shareLockSampleWorkflow(
  client: PoolClient,
  input: WorkflowActor,
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
  return workflow;
}

export async function lockSampleDraft(
  client: PoolClient,
  input: WorkflowActor,
  write: boolean,
) {
  const db = drizzle(client);
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
  return row;
}
