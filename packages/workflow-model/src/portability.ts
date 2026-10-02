import './server-only.js';

import { parseWorkflowGraphDraft, type WorkflowGraph } from './graph.js';
import type { JsonValue } from './graph-contract.js';
import {
  canonicalWorkflowPortableJson,
  workflowPortableManifestSchema,
  type WorkflowPortableManifest,
  type PortableConnectionBinding,
  type PortableConnectionSlot,
  type PortableIssue,
  WORKFLOW_PORTABILITY_LIMITS,
} from './portability-contract.js';

export type WorkflowPortabilityCatalog = Readonly<{
  fingerprint: string;
  definitions: readonly Readonly<{
    key: string;
    version: number;
    configVersion: number;
    slots: readonly PortableConnectionSlotPolicy[];
    validateConfig(config: Readonly<Record<string, JsonValue>>): boolean;
  }>[];
  selectionFingerprint(
    definitions: readonly Readonly<{ key: string; version: number }>[],
  ): string;
}>;
export type PortableConnectionSlotPolicy = Readonly<{
  slot: string;
  providerKey: string;
  authType: string;
}>;

export class WorkflowPortabilityError extends Error {
  public override readonly name = 'WorkflowPortabilityError';
  public readonly code = 'workflow.portability_invalid';
  public readonly issues: readonly PortableIssue[];
  public constructor(code: string, path = '$') {
    super('Portable workflow violates its authoring contract');
    this.issues = Object.freeze([
      {
        code,
        path: path.slice(0, 2_048),
        message:
          'Portable workflow content is not supported or safe for this operation',
      },
    ]);
  }
}

function nodes(graph: WorkflowGraph) {
  const result: WorkflowGraph['nodes'][number][] = [];
  const pending = [graph];
  const ids = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const node of current.nodes) {
      if (ids.has(node.id))
        throw new WorkflowPortabilityError('duplicate_node_id');
      ids.add(node.id);
      result.push(node);
      if (node.structured !== undefined) pending.push(node.structured.body);
    }
  }
  return result;
}

function requireReviewedShape(value: unknown, path: string): void {
  const pending = [{ value, path }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === undefined ||
      current.value === null ||
      typeof current.value !== 'object'
    )
      continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) =>
        pending.push({
          value: child,
          path: `${current.path}[${String(index)}]`,
        }),
      );
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      // Refuse known credential-like shapes; this is not secret-value detection.
      if (/(?:auth|credential|secret|token|api[-_]?key)/iu.test(key))
        throw new WorkflowPortabilityError(
          'credential_like_content',
          current.path,
        );
      pending.push({ value: child, path: `${current.path}.${key}` });
    }
  }
}

function facts(graph: WorkflowGraph, catalog: WorkflowPortabilityCatalog) {
  const definitions = new Map(
    catalog.definitions.map((definition) => [
      `${definition.key}\u0000${String(definition.version)}`,
      definition,
    ]),
  );
  const requirements = new Map<
    string,
    { key: string; version: number; configVersion: number }
  >();
  const slots: PortableConnectionSlot[] = [];
  for (const node of nodes(graph)) {
    const identity = `${node.definition.key}\u0000${String(node.definition.version)}`;
    const definition = definitions.get(identity);
    if (definition === undefined)
      throw new WorkflowPortabilityError('unknown_definition');
    if (
      definition.configVersion !== node.configVersion ||
      !definition.validateConfig(node.config)
    )
      throw new WorkflowPortabilityError('invalid_config');
    requireReviewedShape(node.config, `$.nodes.${node.id}.config`);
    for (const [key, mapping] of Object.entries(node.inputMappings))
      if (mapping.kind === 'literal')
        requireReviewedShape(
          mapping.value,
          `$.nodes.${node.id}.inputMappings.${key}`,
        );
    const knownSlots = new Set(definition.slots.map(({ slot }) => slot));
    if (Object.keys(node.connectionRefs).some((slot) => !knownSlots.has(slot)))
      throw new WorkflowPortabilityError('unexpected_connection_slot');
    requirements.set(identity, {
      ...node.definition,
      configVersion: node.configVersion,
    });
    for (const slot of definition.slots)
      slots.push({ nodeId: node.id, ...slot });
  }
  const compare = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  const selected = [...requirements.values()].sort(
    (left, right) =>
      compare(left.key, right.key) || left.version - right.version,
  );
  slots.sort(
    (left, right) =>
      compare(left.nodeId, right.nodeId) || compare(left.slot, right.slot),
  );
  if (slots.length > WORKFLOW_PORTABILITY_LIMITS.connectionSlots)
    throw new WorkflowPortabilityError('connection_slot_limit');
  return {
    definitions: selected,
    selectionFingerprint: catalog.selectionFingerprint(selected),
    slots,
  };
}

function replaceConnections(
  graph: WorkflowGraph,
  bindings: ReadonlyMap<string, Readonly<Record<string, string>>>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      connectionRefs: bindings.get(node.id) ?? {},
      ...(node.structured === undefined
        ? {}
        : {
            structured: {
              ...node.structured,
              body: {
                ...node.structured.body,
                ...replaceConnections(node.structured.body, bindings),
              },
            },
          }),
    })),
  };
}

export function projectWorkflowPortableManifest(
  input: WorkflowGraph,
  catalog: WorkflowPortabilityCatalog,
): WorkflowPortableManifest {
  const graph = parseWorkflowGraphDraft(input);
  const selected = facts(graph, catalog);
  return workflowPortableManifestSchema.parse({
    format: 'pertexo.workflow',
    formatVersion: 1,
    graph: replaceConnections(graph, new Map()),
    requirements: {
      definitions: selected.definitions,
      selectionFingerprint: selected.selectionFingerprint,
    },
    connectionSlots: selected.slots,
  });
}

/** Check untrusted declarations against serving policy, then rebind only typed references. */
export function inspectWorkflowPortableManifest(
  rawManifest: WorkflowPortableManifest,
  bindings: readonly PortableConnectionBinding[],
  catalog: WorkflowPortabilityCatalog,
): Readonly<{ graph: WorkflowGraph; issues: readonly PortableIssue[] }> {
  const manifest = workflowPortableManifestSchema.parse(rawManifest);
  const graph = parseWorkflowGraphDraft(manifest.graph);
  if (
    nodes(graph).some((node) => Object.keys(node.connectionRefs).length !== 0)
  )
    throw new WorkflowPortabilityError('source_connection_reference');
  const selected = facts(graph, catalog);
  if (
    canonicalWorkflowPortableJson(manifest.requirements) !==
    canonicalWorkflowPortableJson({
      definitions: selected.definitions,
      selectionFingerprint: selected.selectionFingerprint,
    })
  )
    throw new WorkflowPortabilityError('incompatible_requirements');
  if (
    canonicalWorkflowPortableJson(manifest.connectionSlots) !==
    canonicalWorkflowPortableJson(selected.slots)
  )
    throw new WorkflowPortabilityError('invalid_connection_slots');
  const expected = new Set(
    selected.slots.map(({ nodeId, slot }) => JSON.stringify([nodeId, slot])),
  );
  const seen = new Set<string>();
  const connectionRefs = new Map<string, Record<string, string>>();
  for (const binding of bindings) {
    const token = JSON.stringify([binding.nodeId, binding.slot]);
    if (!expected.has(token) || seen.has(token))
      throw new WorkflowPortabilityError('invalid_connection_binding');
    seen.add(token);
    const references = connectionRefs.get(binding.nodeId) ?? {};
    Object.defineProperty(references, binding.slot, {
      value: binding.connectionId,
      enumerable: true,
    });
    connectionRefs.set(binding.nodeId, references);
  }
  const issues: PortableIssue[] = [];
  if (seen.size !== expected.size)
    issues.push({
      code: 'connection_binding_required',
      path: '$.bindings',
      message: 'Choose a destination connection for every required slot',
    });
  return { graph: replaceConnections(graph, connectionRefs), issues };
}
