import type { WorkflowActor } from '../../shared/access/workflow-actor.types.js';
import { decodeStoredValue } from '../../shared/stored-values.js';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../shared/stored-execution.js';
import type { PoolClient } from 'pg';
import {
  parseWorkflowGraphDraft,
  stepSampleBindings,
} from '@pertexo/workflow-model';
import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import { collectArtifactReferences } from '../../artifacts/references/lock-references.js';
import { WorkflowStepSampleError } from './step-sample.errors.js';
import {
  shareLockSampleWorkflow,
  lockSampleDraft,
} from './step-sample-state.repository.js';

export async function sampleDraft(
  client: PoolClient,
  input: WorkflowActor,
  { write }: Readonly<{ write: boolean }>,
) {
  const workflow = await shareLockSampleWorkflow(client, input);
  const workflowUnavailable =
    workflow === undefined || (write && workflow.lifecycleStatus !== 'active');
  if (workflowUnavailable)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const row = await lockSampleDraft(client, input, write);
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const graph = decodeStoredValue(() => parseWorkflowGraphDraft(row.graphJson));
  return {
    revision: row.revision,
    graph,
    bindings: stepSampleBindings(graph),
  };
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
