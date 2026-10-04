import {
  workflowControlOutputKind,
  workflowControlOutputNodeIdsV3,
  workflowControlOutputNodeIdsV2,
} from '@pertexo/workflow-model/graph';
import type { WorkflowControlOutputKind } from '@pertexo/workflow-model/graph';
import type { CoordinatorCheckpoint } from './coordinator-checkpoint.js';
import type { CoordinatorEventRow } from './coordinator-run-store-fact-physical-state.js';
import {
  completedInlineOutput,
  mapEvent,
  record,
} from './coordinator-run-store-observation-facts.js';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import { persistedWorkflowPhysicalOutputReferenceSchemaV3 } from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import type { NativeCoordinatorControlDeclarationIdentity } from './coordinator-control-declaration-source.js';

/** Pinned control identities only; native Call keeps its separate owner. */
export function coordinatorControlPins(executable: unknown): ReadonlyMap<
  string,
  Readonly<{
    kind: WorkflowControlOutputKind;
    node: Readonly<Record<string, unknown>>;
  }>
> {
  workflowControlOutputNodeIdsV3(executable);
  const envelope = record(executable);
  const pending = [record(envelope.graph)];
  const kinds = new Map<
    string,
    Readonly<{
      kind: WorkflowControlOutputKind;
      node: Readonly<Record<string, unknown>>;
    }>
  >();
  while (pending.length !== 0) {
    const graph = pending.pop();
    if (graph === undefined || !Array.isArray(graph.nodes))
      throw new CoordinatorRunStateCorruptError();
    for (const raw of graph.nodes as readonly unknown[]) {
      const node = record(raw);
      const definition = record(node.definition);
      if (
        typeof node.id !== 'string' ||
        typeof definition.key !== 'string' ||
        typeof definition.version !== 'number'
      )
        throw new CoordinatorRunStateCorruptError();
      const kind = workflowControlOutputKind({
        key: definition.key,
        version: definition.version,
      });
      if (kind !== undefined) kinds.set(node.id, { kind, node });
      if (node.structured !== undefined)
        pending.push(record(record(node.structured).body));
    }
  }
  return kinds;
}

/** Needed fact selection, not source authority or hydrated semantic material. */
export function coordinatorControlFactWindow(
  input: Readonly<{
    executable: unknown;
    checkpoint: CoordinatorCheckpoint;
    events: readonly CoordinatorEventRow[];
  }>,
) {
  const kinds = coordinatorControlPins(input.executable);
  const identities: NativeCoordinatorControlDeclarationIdentity[] = [];
  for (const event of input.events) {
    if (event.type !== 'node.succeeded' || event.node_id === null) continue;
    const pin = kinds.get(event.node_id);
    if (pin === undefined) continue;
    const fact = record(mapEvent(event));
    const invocations = input.checkpoint.invocations.filter(
      (invocation) => invocation.invocationKey === event.invocation_key,
    );
    const invocation = invocations[0];
    if (
      invocations.length !== 1 ||
      invocation === undefined ||
      typeof fact.attemptId !== 'string'
    )
      throw new CoordinatorRunStateCorruptError();
    identities.push({
      sequence: event.sequence,
      invocationKey: invocation.invocationKey,
      nodeId: invocation.nodeId,
      attemptId: fact.attemptId,
      output: persistedWorkflowPhysicalOutputReferenceSchemaV3.parse(
        fact.output,
      ),
      controlKind: pin.kind,
      branchPath:
        'branchPath' in invocation ? [...(invocation.branchPath ?? [])] : [],
      iterationPath:
        'iterationPath' in invocation
          ? [...(invocation.iterationPath ?? [])]
          : [],
    });
  }
  return Object.freeze({
    lastSequence:
      input.events.at(-1)?.sequence ?? input.checkpoint.nextEventSequence - 1,
    identities: Object.freeze(identities),
  });
}

/** Keep retained eager-inline material and native metadata-only demand distinct. */
export function coordinatorControlObservationMaterial(
  input: Parameters<typeof coordinatorControlFactWindow>[0],
) {
  try {
    if (input.checkpoint.schemaVersion === 3)
      return {
        completedOutputs: undefined,
        controlDeclarations: coordinatorControlFactWindow(input),
      };
    const ids = workflowControlOutputNodeIdsV2(input.executable);
    return {
      completedOutputs: input.events.flatMap((event) =>
        completedInlineOutput(event, ids),
      ),
      controlDeclarations: undefined,
    };
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
}
