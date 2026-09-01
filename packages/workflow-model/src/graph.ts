import './server-only.js';
import { createHash } from 'node:crypto';
import {
  WORKFLOW_EXECUTION_LIMITS_V1,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  workflowGraphSchema,
  workflowSettingsSchemaV1,
  type ForEachStructure,
  type NodeId,
  type StructuredBody,
  type ValueSource,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowSettings,
} from './graph-contract.js';
import { z } from 'zod';
import {
  canonicalJson,
  canonicalizeJson,
  inspectJsonValue,
  type JsonValue,
} from './canonical-json.js';
import { validateGraphStructure } from './graph-validation.js';

export type {
  ForEachStructure,
  NodeId,
  StructuredBody,
  ValueSource,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowSettings,
};

export interface WorkflowGraphLimits {
  readonly nodes: number;
  readonly edges: number;
  readonly graphBytes: number;
  readonly maxLoopIterations: number;
  readonly maxLoopConcurrency: number;
  readonly maxTotalLoopIterations: number;
  readonly maxExpandedInvocations: number;
  readonly structuredDepth: number;
  readonly jsonValueDepth: number;
  readonly inputDepth: number;
}
export const WORKFLOW_GRAPH_LIMITS: WorkflowGraphLimits = Object.freeze({
  ...WORKFLOW_GRAPH_CONTRACT_LIMITS,
  maxTotalLoopIterations: 1_000,
  maxExpandedInvocations: 1_000,
  structuredDepth: 32,
  jsonValueDepth: 64,
});
export { WORKFLOW_EXECUTION_LIMITS_V1 };
export const WorkflowSettingsSchemaV1 = workflowSettingsSchemaV1;
const workflowGraphInputSchemaV1 = workflowGraphSchema;

export class InvalidWorkflowGraphError extends TypeError {
  constructor(readonly issues: readonly GraphValidationIssue[]) {
    super('workflow graph failed semantic validation');
    this.name = 'InvalidWorkflowGraphError';
  }
}

export type WorkflowGraphContractIssueCode =
  'structured_depth' | 'json_value_depth' | 'invalid_json' | 'graph_limit';

export class WorkflowGraphContractError extends TypeError {
  constructor(
    readonly code: WorkflowGraphContractIssueCode,
    readonly path: string,
    message: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'WorkflowGraphContractError';
  }
}

function ownDataValue(value: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor))
    throw new WorkflowGraphContractError(
      'invalid_json',
      path,
      'accessors are not valid graph input',
    );
  return descriptor.value;
}

function preflightJsonDocument(input: unknown): number {
  type Frame =
    | {
        readonly kind: 'value';
        readonly value: unknown;
        readonly path: string;
        readonly depth: number;
      }
    | { readonly kind: 'exit'; readonly value: object };
  const stack: Frame[] = [{ kind: 'value', value: input, path: '$', depth: 1 }];
  const ancestors = new Set<object>();
  let bytes = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.depth > WORKFLOW_GRAPH_LIMITS.inputDepth)
      throw new WorkflowGraphContractError(
        'json_value_depth',
        frame.path,
        `graph input depth exceeds ${String(WORKFLOW_GRAPH_LIMITS.inputDepth)}`,
      );
    const value = frame.value;
    if (value === null) {
      bytes += 4;
      continue;
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      continue;
    }
    if (typeof value === 'boolean') {
      bytes += value ? 4 : 5;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      continue;
    }
    if (typeof value !== 'object')
      throw new WorkflowGraphContractError(
        'invalid_json',
        frame.path,
        'value is not JSON',
      );
    if (ancestors.has(value))
      throw new WorkflowGraphContractError(
        'invalid_json',
        frame.path,
        'cyclic values are not JSON',
      );
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new WorkflowGraphContractError(
        'invalid_json',
        frame.path,
        'symbol properties are not JSON',
      );
    ancestors.add(value);
    stack.push({ kind: 'exit', value });
    if (Array.isArray(value)) {
      bytes += 2 + Math.max(0, value.length - 1);
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (!(index in value))
          throw new WorkflowGraphContractError(
            'invalid_json',
            `${frame.path}[${String(index)}]`,
            'sparse arrays are not JSON',
          );
        stack.push({
          kind: 'value',
          value: ownDataValue(
            value,
            String(index),
            `${frame.path}[${String(index)}]`,
          ),
          path: `${frame.path}[${String(index)}]`,
          depth: frame.depth + 1,
        });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new WorkflowGraphContractError(
        'invalid_json',
        frame.path,
        'object must be plain',
      );
    const keys = Object.keys(value);
    bytes += 2 + Math.max(0, keys.length - 1);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
      stack.push({
        kind: 'value',
        value: ownDataValue(value, key, `${frame.path}.${key}`),
        path: `${frame.path}.${key}`,
        depth: frame.depth + 1,
      });
    }
  }
  return bytes;
}

function preflightJsonValue(value: unknown, path: string): void {
  const stack: {
    readonly value: unknown;
    readonly path: string;
    depth: number;
  }[] = [{ value, path, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current.depth > WORKFLOW_GRAPH_LIMITS.jsonValueDepth)
      throw new WorkflowGraphContractError(
        'json_value_depth',
        current.path,
        `JSON value depth exceeds ${String(WORKFLOW_GRAPH_LIMITS.jsonValueDepth)}`,
      );
    if (
      current.value === null ||
      typeof current.value === 'string' ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    )
      continue;
    if (typeof current.value !== 'object')
      throw new WorkflowGraphContractError(
        'invalid_json',
        current.path,
        'value is not JSON',
      );
    if (Object.getOwnPropertySymbols(current.value).length > 0)
      throw new WorkflowGraphContractError(
        'invalid_json',
        current.path,
        'symbol properties are not JSON',
      );
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        if (!(index in current.value))
          throw new WorkflowGraphContractError(
            'invalid_json',
            `${current.path}[${String(index)}]`,
            'sparse arrays are not JSON',
          );
        stack.push({
          value: ownDataValue(
            current.value,
            String(index),
            `${current.path}[${String(index)}]`,
          ),
          path: `${current.path}[${String(index)}]`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new WorkflowGraphContractError(
        'invalid_json',
        current.path,
        'object must be plain',
      );
    for (const key of Object.keys(current.value))
      stack.push({
        value: ownDataValue(current.value, key, `${current.path}.${key}`),
        path: `${current.path}.${key}`,
        depth: current.depth + 1,
      });
  }
}

function preflightWorkflowGraph(input: unknown): void {
  const graphs: {
    readonly value: unknown;
    readonly path: string;
    depth: number;
  }[] = [{ value: input, path: '$', depth: 0 }];
  while (graphs.length > 0) {
    const current = graphs.pop();
    if (current === undefined || current.value === null) continue;
    if (current.depth > WORKFLOW_GRAPH_LIMITS.structuredDepth)
      throw new WorkflowGraphContractError(
        'structured_depth',
        current.path,
        `structured graph depth exceeds ${String(WORKFLOW_GRAPH_LIMITS.structuredDepth)}`,
      );
    if (typeof current.value !== 'object' || Array.isArray(current.value))
      continue;
    const nodes = ownDataValue(current.value, 'nodes', `${current.path}.nodes`);
    if (!Array.isArray(nodes)) continue;
    for (let index = 0; index < nodes.length; index += 1) {
      const nodePath = `${current.path}.nodes[${String(index)}]`;
      const node = ownDataValue(nodes, String(index), nodePath);
      if (node === null || typeof node !== 'object' || Array.isArray(node))
        continue;
      const config = ownDataValue(node, 'config', `${nodePath}.config`);
      if (config !== undefined)
        preflightJsonValue(config, `${nodePath}.config`);
      const mappings = ownDataValue(
        node,
        'inputMappings',
        `${nodePath}.inputMappings`,
      );
      if (mappings !== null && typeof mappings === 'object') {
        for (const key of Object.keys(mappings)) {
          const mappingPath = `${nodePath}.inputMappings.${key}`;
          const mapping = ownDataValue(mappings, key, mappingPath);
          if (mapping !== null && typeof mapping === 'object') {
            const kind = ownDataValue(mapping, 'kind', `${mappingPath}.kind`);
            if (kind === 'literal')
              preflightJsonValue(
                ownDataValue(mapping, 'value', `${mappingPath}.value`),
                `${mappingPath}.value`,
              );
          }
        }
      }
      const structured = ownDataValue(
        node,
        'structured',
        `${nodePath}.structured`,
      );
      if (structured !== null && typeof structured === 'object')
        graphs.push({
          value: ownDataValue(
            structured,
            'body',
            `${nodePath}.structured.body`,
          ),
          path: `${nodePath}.structured.body`,
          depth: current.depth + 1,
        });
    }
  }
}

function enforceDraftResourceLimits(graph: WorkflowGraph): void {
  const stack: WorkflowGraph[] = [graph];
  let nodes = 0;
  let edges = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    nodes += current.nodes.length;
    edges += current.edges.length;
    if (
      nodes > WORKFLOW_GRAPH_LIMITS.nodes ||
      edges > WORKFLOW_GRAPH_LIMITS.edges
    )
      throw new WorkflowGraphContractError(
        'graph_limit',
        '$',
        'aggregate node or edge count exceeds the graph limit',
      );
    for (const node of current.nodes)
      if (node.structured !== undefined) stack.push(node.structured.body);
  }
}

export function parseWorkflowGraphDraft(input: unknown): WorkflowGraph {
  const bytes = preflightJsonDocument(input);
  if (bytes > WORKFLOW_GRAPH_LIMITS.graphBytes)
    throw new WorkflowGraphContractError(
      'graph_limit',
      '$',
      'graph bytes exceed the graph limit',
    );
  preflightWorkflowGraph(input);
  const graph = workflowGraphInputSchemaV1.parse(input);
  enforceDraftResourceLimits(graph);
  return graph;
}

export type WorkflowGraphDraftParseResult =
  | { readonly success: true; readonly data: WorkflowGraph }
  | {
      readonly success: false;
      readonly error: WorkflowGraphContractError | z.ZodError;
    };

export function safeParseWorkflowGraphDraft(
  input: unknown,
): WorkflowGraphDraftParseResult {
  try {
    return { success: true, data: parseWorkflowGraphDraft(input) };
  } catch (error) {
    if (
      error instanceof WorkflowGraphContractError ||
      error instanceof z.ZodError
    )
      return { success: false, error };
    return {
      success: false,
      error: new WorkflowGraphContractError(
        'invalid_json',
        '$',
        error instanceof Error ? error.message : 'graph parsing failed',
      ),
    };
  }
}

export const EMPTY_WORKFLOW_GRAPH_V1: WorkflowGraph = Object.freeze({
  schemaVersion: 1,
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
  settings: Object.freeze({}),
});
export type GraphIssueCode =
  | 'duplicate_node_id'
  | 'duplicate_edge_id'
  | 'dangling_edge'
  | 'cycle'
  | 'invalid_loop_limit'
  | 'loop_iteration_limit'
  | 'invalid_structured_body'
  | 'expansion_limit'
  | 'graph_limit'
  | 'unknown_definition'
  | 'invalid_graph';
export interface GraphValidationIssue {
  readonly code: GraphIssueCode;
  readonly path: string;
  readonly message: string;
}
export type GraphValidationResult =
  | {
      readonly ok: true;
      readonly issues: readonly [];
      readonly expandedInvocations: number;
      readonly worstCaseLoopIterations: number;
    }
  | {
      readonly ok: false;
      readonly issues: readonly GraphValidationIssue[];
      readonly expandedInvocations: number;
      readonly worstCaseLoopIterations: number;
    };

export function validateWorkflowGraph(
  graph: WorkflowGraph,
  overrides: Partial<WorkflowGraphLimits> = {},
): GraphValidationResult {
  const limits = { ...WORKFLOW_GRAPH_LIMITS, ...overrides };
  const issues: GraphValidationIssue[] = [];
  const globalNodeIds = new Set<string>();
  const allNodeIds = new Set<string>();
  const pendingGraphs: WorkflowGraph[] = [graph];
  while (pendingGraphs.length > 0) {
    const current = pendingGraphs.pop();
    if (current === undefined) continue;
    for (const node of current.nodes) {
      allNodeIds.add(node.id);
      if (node.structured !== undefined)
        pendingGraphs.push(node.structured.body);
    }
  }
  const aggregate = { nodes: 0, edges: 0 };
  const issue = (code: GraphIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  let expandedInvocations = 0;
  let worstCaseLoopIterations = 0;
  try {
    if (inspectJsonValue(graph).bytes > limits.graphBytes)
      issue('graph_limit', '$', 'canonical graph bytes exceed the limit');
    const totals = validateGraphStructure(graph, '$', {
      aggregate,
      allNodeIds,
      globalNodeIds,
      issue,
      limits,
    });
    expandedInvocations = totals.expanded;
    worstCaseLoopIterations = totals.iterations;
  } catch (error) {
    issue(
      'invalid_graph',
      '$',
      error instanceof Error ? error.message : 'graph is not canonical JSON',
    );
  }
  if (expandedInvocations > limits.maxExpandedInvocations)
    issue(
      'expansion_limit',
      '$',
      `worst-case expansion ${String(expandedInvocations)} exceeds ${String(limits.maxExpandedInvocations)}`,
    );
  if (worstCaseLoopIterations > limits.maxTotalLoopIterations)
    issue(
      'loop_iteration_limit',
      '$',
      `worst-case loop iterations ${String(worstCaseLoopIterations)} exceeds ${String(limits.maxTotalLoopIterations)}`,
    );
  return issues.length === 0
    ? {
        ok: true,
        issues: [],
        expandedInvocations,
        worstCaseLoopIterations,
      }
    : { ok: false, issues, expandedInvocations, worstCaseLoopIterations };
}

export interface WorkflowDefinitionCatalogV1 {
  readonly schemaVersion: 1;
  /** Full durable release identity selected by the serving artifact. */
  readonly releaseFingerprint?: string;
  readonly definitions: readonly {
    readonly key: string;
    readonly version: number;
    /** Optional projection metadata; it does not participate in compatibility identity. */
    readonly integration?: Readonly<{
      readonly providerKey: string;
      readonly operationKey: string;
      readonly connectionSlots: readonly string[];
    }>;
  }[];
}

export type WorkflowIntegrationUsage = Readonly<{
  providerKey: string;
  operationKey: string;
  connectionId: string;
}>;

export const EMPTY_DEFINITION_CATALOG_V1: WorkflowDefinitionCatalogV1 =
  Object.freeze({ schemaVersion: 1, definitions: Object.freeze([]) });

export interface WorkflowCompatibilityIssue {
  readonly code: 'unknown_definition';
  readonly definitionKey: string;
  readonly version: number;
}

export interface WorkflowCompatibilityReport {
  readonly compatible: boolean;
  readonly fingerprint: string;
  readonly issues: readonly WorkflowCompatibilityIssue[];
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function definitionCatalogFingerprint(
  catalog: WorkflowDefinitionCatalogV1,
): string {
  if (catalog.releaseFingerprint !== undefined) {
    if (
      !/^node-compat:v1:sha256:[0-9a-f]{64}$/u.test(catalog.releaseFingerprint)
    ) {
      throw new TypeError('Workflow definition catalog release is invalid');
    }
    return catalog.releaseFingerprint;
  }
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.definition-compatibility',
        catalogVersion: catalog.schemaVersion,
        definitions: [...catalog.definitions]
          .map(({ key, version }) => ({ key, version }))
          .sort(
            (left, right) =>
              compareOrdinal(left.key, right.key) ||
              left.version - right.version,
          ),
      }),
    )
    .digest('hex');
  return `wf-compat:v1:sha256:${digest}`;
}

/**
 * Derive the exact integration index from a graph and its pinned definition
 * catalog. The result is disposable: the graph remains the sole authority.
 */
export function workflowIntegrationUsage(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): readonly WorkflowIntegrationUsage[] {
  const graph = parseWorkflowGraphDraft(input);
  const definitions = new Map(
    catalog.definitions.map((definition) => [
      `${definition.key}\u0000${String(definition.version)}`,
      definition.integration,
    ]),
  );
  const usages = new Map<string, WorkflowIntegrationUsage>();
  const pending: WorkflowGraph[] = [graph];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const node of current.nodes) {
      const integration = definitions.get(
        `${node.definition.key}\u0000${String(node.definition.version)}`,
      );
      if (integration !== undefined) {
        for (const slot of integration.connectionSlots) {
          const connectionId = node.connectionRefs[slot];
          if (connectionId === undefined) {
            throw new TypeError(
              `Integration definition ${node.definition.key}@${String(node.definition.version)} requires connection slot ${slot}`,
            );
          }
          const usage = Object.freeze({
            providerKey: integration.providerKey,
            operationKey: integration.operationKey,
            connectionId,
          });
          usages.set(
            `${usage.providerKey}\u0000${usage.operationKey}\u0000${usage.connectionId}`,
            usage,
          );
        }
      }
      if (node.structured !== undefined) pending.push(node.structured.body);
    }
  }
  return Object.freeze(
    [...usages.values()].sort(
      (left, right) =>
        compareOrdinal(left.providerKey, right.providerKey) ||
        compareOrdinal(left.operationKey, right.operationKey) ||
        compareOrdinal(left.connectionId, right.connectionId),
    ),
  );
}

export const EMPTY_DEFINITION_CATALOG_FINGERPRINT_V1 =
  definitionCatalogFingerprint(EMPTY_DEFINITION_CATALOG_V1);

function compatibilityForGraph(
  graph: WorkflowGraph,
  catalog: WorkflowDefinitionCatalogV1,
): WorkflowCompatibilityReport {
  const known = new Set(
    catalog.definitions.map(
      (definition) => `${definition.key}\u0000${String(definition.version)}`,
    ),
  );
  const unknown = new Map<string, WorkflowCompatibilityIssue>();
  const stack: WorkflowGraph[] = [graph];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const node of current.nodes) {
      const identity = `${node.definition.key}\u0000${String(node.definition.version)}`;
      if (!known.has(identity))
        unknown.set(identity, {
          code: 'unknown_definition',
          definitionKey: node.definition.key,
          version: node.definition.version,
        });
      if (node.structured !== undefined) stack.push(node.structured.body);
    }
  }
  const issues = [...unknown.values()].sort(
    (left, right) =>
      compareOrdinal(left.definitionKey, right.definitionKey) ||
      left.version - right.version,
  );
  return {
    compatible: issues.length === 0,
    fingerprint: definitionCatalogFingerprint(catalog),
    issues,
  };
}

export function workflowCompatibilityReport(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): WorkflowCompatibilityReport {
  return compatibilityForGraph(parseWorkflowGraphDraft(input), catalog);
}

export function parseWorkflowGraphForPublish(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): WorkflowGraph {
  const graph = parseWorkflowGraphDraft(input);
  const validation = validateWorkflowGraph(graph);
  const compatibility = compatibilityForGraph(graph, catalog);
  const compatibilityIssues: GraphValidationIssue[] = compatibility.issues.map(
    (issue) => ({
      code: 'unknown_definition',
      path: '$.nodes',
      message: `unknown definition ${issue.definitionKey}@${String(issue.version)}`,
    }),
  );
  const issues = validation.ok
    ? compatibilityIssues
    : [...validation.issues, ...compatibilityIssues];
  if (issues.length > 0) throw new InvalidWorkflowGraphError(issues);
  return graph;
}

function executableGraphProjection(
  graph: WorkflowGraph,
): Readonly<Record<string, JsonValue>> {
  return canonicalizeJson({
    schemaVersion: graph.schemaVersion,
    nodes: [...graph.nodes]
      .sort((left, right) => compareOrdinal(left.id, right.id))
      .map((node) => {
        const projected: Record<string, JsonValue> = {
          id: node.id,
          definition: node.definition,
          configVersion: node.configVersion,
          config: node.config,
          inputMappings: node.inputMappings,
          connectionRefs: node.connectionRefs,
          disabled: node.disabled ?? false,
        };
        if (node.structured !== undefined) {
          projected.structured = {
            kind: node.structured.kind,
            maxIterations: node.structured.maxIterations,
            maxConcurrency: node.structured.maxConcurrency,
            body: {
              ...executableGraphProjection(node.structured.body),
              inputPorts: node.structured.body.inputPorts,
              outputPorts: node.structured.body.outputPorts,
            },
          };
        }
        return projected;
      }),
    edges: [...graph.edges]
      .sort((left, right) => compareOrdinal(left.id, right.id))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    settings:
      graph.settings.maxRunDurationMs === undefined
        ? {}
        : { maxRunDurationMs: graph.settings.maxRunDurationMs },
  }) as Readonly<Record<string, JsonValue>>;
}

export function workflowExecutableProjection(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): JsonValue {
  return executableGraphProjection(
    parseWorkflowGraphForPublish(input, catalog),
  );
}

export function workflowExecutableChecksum(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): string {
  return checksumExecutableProjection(
    workflowExecutableProjection(input, catalog),
  );
}

function checksumExecutableProjection(projection: JsonValue): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.executable',
        checksumVersion: 1,
        graph: projection,
      }),
    )
    .digest('hex');
  return `wf:v1:sha256:${digest}`;
}

/**
 * Recomputes the canonical identity of a retained V1 version without requiring
 * its pinned definitions to remain in the active publication catalog.
 * Structural and graph-semantic corruption still fails closed.
 */
export function workflowRetainedExecutableChecksum(input: unknown): string {
  const graph = parseWorkflowGraphDraft(input);
  const validation = validateWorkflowGraph(graph);
  if (!validation.ok) throw new InvalidWorkflowGraphError(validation.issues);
  return checksumExecutableProjection(executableGraphProjection(graph));
}

export interface RetainedWorkflowVersionV1 {
  readonly format: 'v1';
  readonly executable: false;
  readonly graphSchemaVersion: 1;
  readonly graph: WorkflowGraph;
  readonly checksum: `wf:v1:sha256:${string}`;
}

type WorkflowChecksumV1 = `wf:v1:sha256:${string}`;
const workflowChecksumV1Pattern = /^wf:v1:sha256:[a-f0-9]{64}$/u;
const workflowChecksumV1Schema = z.custom<WorkflowChecksumV1>(
  (value) => typeof value === 'string' && workflowChecksumV1Pattern.test(value),
  'invalid workflow V1 checksum',
);

const retainedWorkflowVersionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    graphJson: z.unknown(),
    checksum: workflowChecksumV1Schema,
    executableSchemaVersion: z.null(),
    executableJson: z.null(),
    compatibilityReleaseEpoch: z.null(),
  })
  .strict();

/**
 * Verifies a retained Phase 2 row under its original V1 identity rules.
 * V1 remains readable for diagnosis and migration, but deliberately cannot be
 * admitted for execution because it has no pinned executor or runtime policy.
 */
export function parseRetainedWorkflowVersionV1(
  input: unknown,
): RetainedWorkflowVersionV1 {
  const retained = retainedWorkflowVersionV1Schema.parse(input);
  const graph = parseWorkflowGraphDraft(retained.graphJson);
  const checksum = workflowRetainedExecutableChecksum(graph);
  if (checksum !== retained.checksum)
    throw new Error('retained workflow V1 checksum does not match its graph');
  return Object.freeze({
    format: 'v1',
    executable: false,
    graphSchemaVersion: 1,
    graph,
    checksum: retained.checksum,
  });
}

export type WorkflowDraftRepresentationTag = `"draft-v1.${string}"`;

export function workflowDraftRepresentationTag(input: {
  readonly workflowId: string;
  readonly revision: number;
  readonly graph: unknown;
  readonly compatibilityFingerprint: string;
}): WorkflowDraftRepresentationTag {
  const workflowId = z.uuid().parse(input.workflowId);
  const revision = z.number().int().positive().parse(input.revision);
  const graph = parseWorkflowGraphDraft(input.graph);
  const compatibilityFingerprint = z
    .string()
    .min(1)
    .max(256)
    .parse(input.compatibilityFingerprint);
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.draft-representation',
        tagVersion: 1,
        workflowId,
        revision,
        schemaVersion: graph.schemaVersion,
        graph,
        compatibilityFingerprint,
      }),
    )
    .digest('base64url');
  return `"draft-v1.${digest}"`;
}

export type InvocationScopePart =
  | { readonly kind: 'branch'; readonly branchId: string }
  | {
      readonly kind: 'iteration';
      readonly loopNodeId: string;
      readonly ordinal: number;
    };
export interface InvocationIdentityInput {
  readonly workflowRunId: string;
  readonly workflowVersionId: string;
  readonly nodeId: NodeId;
  readonly scope: readonly InvocationScopePart[];
}
export class InvalidInvocationScopeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInvocationScopeError';
  }
}
export function invocationIdentity(input: InvocationIdentityInput): {
  readonly workflowRunId: string;
  readonly canonicalScope: string;
  readonly invocationKey: string;
} {
  if (!input.workflowRunId || !input.workflowVersionId || !input.nodeId)
    throw new InvalidInvocationScopeError(
      'run, version, and node identifiers must be non-empty',
    );
  for (const part of input.scope) {
    if (part.kind === 'branch' && !part.branchId)
      throw new InvalidInvocationScopeError(
        'branch identifiers must be non-empty',
      );
    if (
      part.kind === 'iteration' &&
      (!part.loopNodeId ||
        !Number.isSafeInteger(part.ordinal) ||
        part.ordinal < 0)
    )
      throw new InvalidInvocationScopeError(
        'loop scopes require a non-empty node and zero-based safe ordinal',
      );
  }
  const canonicalScope = input.scope
    .map((part) =>
      part.kind === 'branch'
        ? `branch:${encodeURIComponent(part.branchId)}`
        : `loop:${encodeURIComponent(part.loopNodeId)}[${String(part.ordinal)}]`,
    )
    .join('/');
  const invocationKey = createHash('sha256')
    .update(
      canonicalJson({
        version: input.workflowVersionId,
        node: input.nodeId,
        scope: input.scope,
      }),
    )
    .digest('hex');
  return { workflowRunId: input.workflowRunId, canonicalScope, invocationKey };
}
