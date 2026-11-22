import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FrozenWorkflowTestPins } from '@pertexo/database/schema';
import {
  parseWorkflowGraphDraft,
  stepSampleBindings,
  workflowTestStepChoices,
} from '@pertexo/workflow-model';
import type { WorkflowTestPins } from '@pertexo/workflow-engine/server';
import type { WorkflowActor } from '../../shared/access/workflow-actor.types.js';
import { decodeStoredValue } from '../../shared/stored-values.js';
import { parseStoredExecutionValue } from '../../shared/stored-execution.js';
import { readDatabaseClock } from '../../shared/database-clock.repository.js';
import { sampleDraft } from '../../authoring/step-samples/step-sample-state.js';
import { readVersionGraph } from '../../authoring/workflows/commands/version-sources.repository.js';
import type { WorkflowTestOptions } from './workflow-test.types.js';
import { WorkflowTestError } from './workflow-test.errors.js';
import { lockWorkflowSamples } from './snapshot.repository.js';

export type TestSnapshot = Awaited<ReturnType<typeof loadTestSnapshot>>;

export async function loadTestSnapshot(
  client: PoolClient,
  input: WorkflowActor,
  options: WorkflowTestOptions,
  versionId?: string,
) {
  const draft = await sampleDraft(client, input, { write: true });
  const { graph, bindings } =
    versionId === undefined
      ? draft
      : await loadVersion(client, input, versionId);
  const samples = await lockWorkflowSamples(client, input);
  const now = await readDatabaseClock(drizzle(client));
  const pins: Record<string, WorkflowTestPins[string]> = Object.create(
    null,
  ) as Record<string, WorkflowTestPins[string]>;
  const frozenPins: Record<string, FrozenWorkflowTestPins[string]> =
    Object.create(null) as Record<string, FrozenWorkflowTestPins[string]>;
  for (const sample of samples) {
    // A published graph can use pins whose binding still matches that version.
    if (
      versionId !== undefined &&
      bindings.get(sample.nodeId) !== sample.binding
    )
      continue;
    if (
      sample.expiresAt <= now ||
      bindings.get(sample.nodeId) !== sample.binding
    )
      throw new WorkflowTestError('stale_sample');
    const output = decodeStoredValue(() =>
      parseStoredExecutionValue(sample.outputRef),
    );
    if (output.kind !== 'inline') throw new WorkflowTestError('stale_sample');
    pins[sample.nodeId] = { sampleId: sample.id, output: output.value };
    frozenPins[sample.nodeId] = {
      sampleId: sample.id,
      outputRef: sample.outputRef,
    };
  }
  if (options.workflowTestCompiler === undefined)
    throw new WorkflowTestError('not_supported');
  const compiled = options.workflowTestCompiler(graph, pins);
  if (compiled.invalidPinIds.length > 0)
    throw new WorkflowTestError('pin_invalid');
  const labels = new Map(
    workflowTestStepChoices(graph).map((node) => [node.nodeId, node.label]),
  );
  return {
    graph,
    compiled,
    frozenPins,
    now,
    usesConnections: compiled.usesConnections,
    preparation: {
      draftRevision: draft.revision,
      samples: Object.entries(pins).map(([nodeId, pin]) => ({
        nodeId,
        sampleId: pin.sampleId,
      })),
      effectfulSteps: compiled.effectfulNodeIds.map((nodeId) => ({
        nodeId,
        label: labels.get(nodeId) ?? nodeId,
      })),
    },
  };
}

async function loadVersion(
  client: PoolClient,
  input: WorkflowActor,
  versionId: string,
) {
  const stored = await readVersionGraph(client, { ...input, versionId });
  if (stored === undefined) throw new WorkflowTestError('not_found');
  const graph = decodeStoredValue(() => parseWorkflowGraphDraft(stored));
  return { graph, bindings: stepSampleBindings(graph) };
}
