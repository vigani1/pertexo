import type { FrozenWorkflowTestPins } from '../../schema/runs/tests.js';
import { sampleDraft } from '../../authoring/step-samples/records.js';
import type { PoolClient } from 'pg';
import { canonicalJson } from '@pertexo/workflow-model';
import type { WorkflowTestPins } from '@pertexo/workflow-engine';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import {
  SAMPLE_COLUMNS,
  type SampleRow,
} from '../../authoring/step-samples/contract.js';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { WorkflowTestError } from './contract.js';

export async function loadTestSnapshot(
  client: PoolClient,
  input: SampleScope,
  catalogs: AuthoringCatalogs,
) {
  const draft = await sampleDraft(client, input, true);
  const { graph, bindings } = draft;
  const samples = await client.query<SampleRow>(
    `select ${SAMPLE_COLUMNS} from app.workflow_step_samples where workspace_id=$1 and workflow_id=$2 order by node_id for share`,
    [input.workspaceId, input.workflowId],
  );
  const clock = await client.query<{ now: Date }>(
    'select clock_timestamp() now',
  );
  const now = clock.rows[0]?.now;
  if (now === undefined) throw new Error('Test admission time is unavailable');
  const pins: Record<string, WorkflowTestPins[string]> = Object.create(
    null,
  ) as Record<string, WorkflowTestPins[string]>;
  const frozenPins: Record<string, FrozenWorkflowTestPins[string]> =
    Object.create(null) as Record<string, FrozenWorkflowTestPins[string]>;
  for (const sample of samples.rows) {
    if (
      sample.expires_at <= now ||
      bindings.get(sample.node_id) !== sample.binding
    )
      throw new WorkflowTestError('stale_sample');
    const output = parseStoredExecutionValue(sample.output_ref);
    if (output.kind !== 'inline') throw new WorkflowTestError('stale_sample');
    pins[sample.node_id] = { sampleId: sample.id, output: output.value };
    frozenPins[sample.node_id] = {
      sampleId: sample.id,
      outputRef: sample.output_ref,
    };
  }
  if (catalogs.workflowTestCompiler === undefined)
    throw new WorkflowTestError('not_supported');
  const compiled = catalogs.workflowTestCompiler(graph, pins);
  if (compiled.invalidPinIds.length > 0)
    throw new WorkflowTestError('pin_invalid');
  const labels = new Map(
    (function flatten(nodes: typeof graph.nodes): typeof graph.nodes {
      return nodes.flatMap((node) => [
        node,
        ...(node.structured === undefined
          ? []
          : flatten(node.structured.body.nodes)),
      ]);
    })(graph.nodes).map((node) => [node.id, node.label ?? node.definition.key]),
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
export function sameTestSamples(
  left: readonly { nodeId: string; sampleId: string }[],
  right: readonly { nodeId: string; sampleId: string }[],
) {
  const sort = (items: typeof left) =>
    [...items].sort((a, b) =>
      a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
    );
  return canonicalJson(sort(left)) === canonicalJson(sort(right));
}
