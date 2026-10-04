import { isDeepStrictEqual } from 'node:util';
import {
  configuredBranchOutputPorts,
  configuredParallelOutputPorts,
  inspectBranchSelection,
  inspectForEachCollection,
  inspectParallelDeclaration,
} from '@pertexo/workflow-model';
import { workflowForEachBoundsV3 } from '@pertexo/workflow-model/graph';
import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import { record } from './coordinator-run-store-observation-facts.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import type { loadCoordinatorControlPrecommitMaterial } from './coordinator-control-precommit-material.js';
import type { NativeCoordinatorControlDeclarationSource } from './coordinator-control-declaration-source.js';

type Material = Awaited<
  ReturnType<typeof loadCoordinatorControlPrecommitMaterial>
>;

function require(value: boolean): asserts value {
  if (!value) throw new CoordinatorPlanInvalidError();
}

/** Compare fresh value semantics, not scheduling decisions or worker-supplied summaries. */
export function validateCoordinatorControlValue(
  material: Material,
  plan: ParsedTransitionPlan,
  source: NativeCoordinatorControlDeclarationSource,
  value: unknown,
) {
  const pin = material.pins.get(source.nodeId);
  require(pin?.kind === source.controlKind);
  const definition = record(pin.node.definition);
  require(
    typeof definition.key === 'string' &&
      typeof definition.version === 'number',
  );
  const node = {
    definition: { key: definition.key, version: definition.version },
    config: pin.node.config,
  };
  if (source.controlKind === 'branch') {
    const ports = configuredBranchOutputPorts(node);
    require(ports !== undefined);
    const selected = inspectBranchSelection(value, ports);
    const selections =
      plan.checkpoint.schemaVersion === 1
        ? []
        : plan.checkpoint.branchSelections.filter(
            (entry) => entry.invocationKey === source.invocationKey,
          );
    require(
      selections.length === 1 &&
        selections[0]?.nodeId === source.nodeId &&
        selections[0].selectedOutputPort === selected,
    );
    return;
  }
  if (source.controlKind === 'parallel') {
    const ports = configuredParallelOutputPorts(node);
    require(ports !== undefined && source.output.kind === 'inline');
    inspectParallelDeclaration(value, ports);
    return;
  }
  const collection = inspectForEachCollection(value);
  const bound = workflowForEachBoundsV3(material.executable).get(source.nodeId);
  require(
    bound !== undefined &&
      isDeepStrictEqual(
        bound.ancestorLoopNodeIds,
        source.iterationPath.map(({ loopNodeId }) => loopNodeId),
      ),
  );
  const loops = plan.checkpoint.loops.filter(
    (loop) => loop.controlInvocationKey === source.invocationKey,
  );
  if (loops.length === 0) {
    // The established locked rejected-declaration proof must still validate
    // physical ownership, exact failure settlement and ancestor active ledger.
    require(
      plan.events.some(
        (event) =>
          event.name === 'node.failed' &&
          event.invocationKey === source.invocationKey &&
          event.reasonCode === 'loop_limit_exceeded',
      ),
    );
    require(
      collection.collectionSize > bound.maxIterations ||
        collection.collectionSize >
          material.checkpoint.remainingIterationBudget,
    );
    return collection;
  }
  const loop = loops[0];
  require(loops.length === 1 && loop !== undefined);
  const structured = record(pin.node.structured);
  const body = record(structured.body);
  require(
    structured.kind === 'for_each' &&
      Array.isArray(body.nodes) &&
      Array.isArray(body.edges),
  );
  const nodes: readonly unknown[] = body.nodes;
  const edges: readonly unknown[] = body.edges;
  const ids = nodes.map((raw) => record(raw).id);
  require(ids.every((id) => typeof id === 'string'));
  const targets = new Set(
    edges.map((raw) => record(record(raw).target).nodeId),
  );
  const sources = new Set(
    edges.map((raw) => record(record(raw).source).nodeId),
  );
  const roots = ids.filter((id) => !targets.has(id)).sort();
  const sinks = ids.filter((id) => !sources.has(id));
  require(
    sinks.length === 1 &&
      loop.loopId === source.nodeId &&
      isDeepStrictEqual(loop.collection, source.output) &&
      loop.collectionSize === collection.collectionSize &&
      loop.collectionChecksum === collection.collectionChecksum &&
      loop.maxIterations === bound.maxIterations &&
      loop.maxConcurrency === bound.maxConcurrency &&
      isDeepStrictEqual(loop.branchPath, source.branchPath) &&
      isDeepStrictEqual(loop.iterationPath, source.iterationPath) &&
      isDeepStrictEqual(loop.bodyRootNodeIds, roots) &&
      loop.bodySinkNodeId === sinks[0],
  );
  return collection;
}

/** No new loop/branch declaration may be invented outside the fresh physical facts. */
export function validateCoordinatorControlDeclarationSet(
  material: Material,
  plan: ParsedTransitionPlan,
): void {
  const loops = new Set(
    material.checkpoint.loops.map((loop) => loop.controlInvocationKey),
  );
  for (const source of material.sources)
    if (source.controlKind === 'for_each') loops.add(source.invocationKey);
  require(
    plan.checkpoint.loops.every((loop) => loops.has(loop.controlInvocationKey)),
  );
  require(plan.checkpoint.schemaVersion === 3);
  const selections = new Map(
    material.checkpoint.branchSelections.map((selection) => [
      selection.invocationKey,
      selection,
    ]),
  );
  const fresh = new Set(
    material.sources
      .filter((source) => source.controlKind === 'branch')
      .map((source) => source.invocationKey),
  );
  for (const selection of plan.checkpoint.branchSelections) {
    const previous = selections.get(selection.invocationKey);
    require(
      previous === undefined
        ? fresh.has(selection.invocationKey)
        : isDeepStrictEqual(previous, selection),
    );
    selections.delete(selection.invocationKey);
  }
  require(selections.size === 0);
}
