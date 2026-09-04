import { z } from 'zod';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type NodeId = string;
export type ValueSource =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'run_input'; readonly path: string }
  | {
      readonly kind: 'node_output';
      readonly nodeId: NodeId;
      readonly path: string;
    }
  | {
      readonly kind: 'expression';
      readonly language: 'jsonata';
      readonly expression: string;
      readonly policyVersion: number;
    }
  | {
      readonly kind: 'structured_input';
      readonly port: string;
      readonly path: string;
    };
export interface WorkflowEdge {
  readonly id: string;
  readonly source: { readonly nodeId: NodeId; readonly port: string };
  readonly target: { readonly nodeId: NodeId; readonly port: string };
}
export interface WorkflowSettings {
  readonly maxRunDurationMs?: number | undefined;
}
export interface StructuredBody extends WorkflowGraph {
  readonly inputPorts: readonly string[];
  readonly outputPorts: readonly string[];
}
export interface ForEachStructure {
  readonly kind: 'for_each';
  readonly maxIterations: number;
  readonly maxConcurrency: number;
  readonly body: StructuredBody;
}
export interface WorkflowNode {
  readonly id: NodeId;
  readonly definition: { readonly key: string; readonly version: number };
  readonly position: { readonly x: number; readonly y: number };
  readonly configVersion: number;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly inputMappings: Readonly<Record<string, ValueSource>>;
  readonly connectionRefs: Readonly<Record<string, string>>;
  readonly label?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly structured?: ForEachStructure | undefined;
}
export interface WorkflowGraph {
  readonly schemaVersion: number;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly settings: WorkflowSettings;
}

export const WORKFLOW_GRAPH_CONTRACT_LIMITS = Object.freeze({
  nodes: 1_000,
  edges: 4_000,
  graphBytes: 1_048_576,
  maxLoopIterations: 1_000,
  maxLoopConcurrency: 1_000,
  structuredDepth: 32,
  inputDepth: 256,
});
export const WORKFLOW_EXECUTION_LIMITS_V1 = Object.freeze({
  maxRunDurationMs: 3_600_000,
});
export const WORKFLOW_VALIDATION_MAX_ISSUES = 100;

const identifierSchema = z.string().min(1);
const positiveVersionSchema = z.number().int().positive();
const jsonRecordSchema = z.record(z.string(), z.json());
const valueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.json() }).strict(),
  z.object({ kind: z.literal('run_input'), path: z.string() }).strict(),
  z
    .object({
      kind: z.literal('node_output'),
      nodeId: identifierSchema,
      path: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('expression'),
      language: z.literal('jsonata'),
      expression: z.string(),
      policyVersion: positiveVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('structured_input'),
      port: identifierSchema,
      path: z.string(),
    })
    .strict(),
]);
export const workflowSettingsSchemaV1 = z
  .object({
    maxRunDurationMs: z
      .number()
      .int()
      .positive()
      .max(WORKFLOW_EXECUTION_LIMITS_V1.maxRunDurationMs)
      .optional(),
  })
  .strict();

const workflowEdgeSchema = z
  .object({
    id: identifierSchema,
    source: z
      .object({ nodeId: identifierSchema, port: identifierSchema })
      .strict(),
    target: z
      .object({ nodeId: identifierSchema, port: identifierSchema })
      .strict(),
  })
  .strict();

const workflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z
    .object({
      id: identifierSchema,
      definition: z
        .object({ key: identifierSchema, version: positiveVersionSchema })
        .strict(),
      position: z.object({ x: z.number(), y: z.number() }).strict(),
      configVersion: positiveVersionSchema,
      config: jsonRecordSchema,
      inputMappings: z.record(z.string(), valueSourceSchema),
      connectionRefs: z.record(z.string(), identifierSchema),
      label: z.string().optional(),
      disabled: z.boolean().optional(),
      structured: z
        .object({
          kind: z.literal('for_each'),
          maxIterations: z
            .number()
            .int()
            .positive()
            .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopIterations),
          maxConcurrency: z
            .number()
            .int()
            .positive()
            .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopConcurrency),
          body: z.lazy(() => structuredBodySchema),
        })
        .strict()
        .optional(),
    })
    .strict(),
);

const structuredBodySchema: z.ZodType<StructuredBody> = z.lazy(() =>
  z
    .object({
      schemaVersion: z.literal(1),
      nodes: z.array(workflowNodeSchema),
      edges: z.array(workflowEdgeSchema),
      settings: workflowSettingsSchemaV1,
      inputPorts: z.array(identifierSchema),
      outputPorts: z.array(identifierSchema),
    })
    .strict(),
);

const rawWorkflowGraphSchemaV1: z.ZodType<WorkflowGraph> = z.lazy(() =>
  z
    .object({
      schemaVersion: z.literal(1),
      nodes: z
        .array(workflowNodeSchema)
        .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.nodes),
      edges: z
        .array(workflowEdgeSchema)
        .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.edges),
      settings: workflowSettingsSchemaV1,
    })
    .strict(),
);

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function preflightWorkflowGraphUnsafe(input: unknown): boolean {
  const stack: readonly [unknown, number][] = [[input, 1]];
  const pending = [...stack];
  const ancestors = new Set<object>();
  const exits = new Set<object>();
  let bytes = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const [value, depth] = entry;
    if (depth > WORKFLOW_GRAPH_CONTRACT_LIMITS.inputDepth) return false;
    if (value === null || typeof value !== 'object') {
      if (
        value === undefined ||
        typeof value === 'bigint' ||
        typeof value === 'function' ||
        typeof value === 'symbol'
      )
        return false;
      const encoded = JSON.stringify(value);
      bytes += utf8Bytes(encoded);
      if (bytes > WORKFLOW_GRAPH_CONTRACT_LIMITS.graphBytes) return false;
      continue;
    }
    if (exits.has(value)) {
      exits.delete(value);
      ancestors.delete(value);
      continue;
    }
    if (ancestors.has(value)) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      return false;
    ancestors.add(value);
    exits.add(value);
    pending.push([value, depth]);
    const keys = Array.isArray(value)
      ? Array.from({ length: value.length }, (_, index) => String(index))
      : Object.keys(value);
    bytes += 2 + Math.max(0, keys.length - 1);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return false;
      if (Array.isArray(value) && !(Number(key) in value)) return false;
      if (!Array.isArray(value)) bytes += utf8Bytes(JSON.stringify(key)) + 1;
      pending.push([descriptor.value, depth + 1]);
    }
    if (bytes > WORKFLOW_GRAPH_CONTRACT_LIMITS.graphBytes) return false;
  }
  return true;
}

function hasBoundedGraphAggregateUnsafe(input: unknown): boolean {
  const pending: readonly [unknown, number][] = [[input, 0]];
  const graphs = [...pending];
  let nodes = 0;
  let edges = 0;
  while (graphs.length > 0) {
    const entry = graphs.pop();
    if (entry === undefined) continue;
    const [value, depth] = entry;
    if (depth > WORKFLOW_GRAPH_CONTRACT_LIMITS.structuredDepth) return false;
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      continue;
    const nodeDescriptor = Object.getOwnPropertyDescriptor(value, 'nodes');
    const edgeDescriptor = Object.getOwnPropertyDescriptor(value, 'edges');
    if (!nodeDescriptor || !('value' in nodeDescriptor)) continue;
    if (!edgeDescriptor || !('value' in edgeDescriptor)) continue;
    const graphNodes = nodeDescriptor.value as unknown;
    const graphEdges = edgeDescriptor.value as unknown;
    if (!Array.isArray(graphNodes) || !Array.isArray(graphEdges)) continue;
    nodes += graphNodes.length;
    edges += graphEdges.length;
    if (
      nodes > WORKFLOW_GRAPH_CONTRACT_LIMITS.nodes ||
      edges > WORKFLOW_GRAPH_CONTRACT_LIMITS.edges
    )
      return false;
    for (let index = graphNodes.length - 1; index >= 0; index -= 1) {
      const nodeDescriptor = Object.getOwnPropertyDescriptor(
        graphNodes,
        String(index),
      );
      if (!nodeDescriptor || !('value' in nodeDescriptor)) continue;
      const node = nodeDescriptor.value as unknown;
      if (node === null || typeof node !== 'object' || Array.isArray(node))
        continue;
      const structuredDescriptor = Object.getOwnPropertyDescriptor(
        node,
        'structured',
      );
      if (!structuredDescriptor || !('value' in structuredDescriptor)) continue;
      const structured = structuredDescriptor.value as unknown;
      if (
        structured === null ||
        typeof structured !== 'object' ||
        Array.isArray(structured)
      )
        continue;
      const bodyDescriptor = Object.getOwnPropertyDescriptor(
        structured,
        'body',
      );
      if (bodyDescriptor && 'value' in bodyDescriptor)
        graphs.push([bodyDescriptor.value, depth + 1]);
    }
  }
  return true;
}

function preflightWorkflowGraph(input: unknown): boolean {
  try {
    return (
      preflightWorkflowGraphUnsafe(input) &&
      hasBoundedGraphAggregateUnsafe(input)
    );
  } catch {
    return false;
  }
}

const workflowGraphPreflightSchema = z.custom<unknown>(preflightWorkflowGraph, {
  message: 'workflow graph exceeds the bounded JSON contract',
});

export const workflowGraphSchema: z.ZodType<WorkflowGraph> =
  workflowGraphPreflightSchema.pipe(rawWorkflowGraphSchemaV1);
