import { z } from 'zod';

import { hasBoundedGraphAggregateUnsafe } from './graph/aggregate.js';
import { inspectWorkflowGraphAdmission } from './graph/admission.js';
import {
  escapeDroppedInputMappingKeys,
  restoreDroppedInputMappingKeys,
} from './graph/input-mapping-keys.js';

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

/**
 * Structurally representable projection for contract generators. Runtime
 * browser/public callers use workflowGraphSchema, which adds hostile-input
 * and aggregate preflight; the server parser applies equivalent guards before
 * calling this structural parser.
 */
export const workflowGraphStructuralSchemaV1: z.ZodType<WorkflowGraph> = z.lazy(
  () =>
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

const workflowGraphPreflightSchema = z.unknown().transform((input, context) => {
  const admitted = inspectWorkflowGraphAdmission(
    input,
    {
      ...WORKFLOW_GRAPH_CONTRACT_LIMITS,
      jsonValueDepth: 64,
    },
    { allowNonFiniteNumbers: true },
  );
  if (
    !admitted.ok ||
    !hasBoundedGraphAggregateUnsafe(
      admitted.snapshot,
      WORKFLOW_GRAPH_CONTRACT_LIMITS,
    )
  ) {
    context.addIssue({
      code: 'custom',
      message: 'workflow graph exceeds the bounded JSON contract',
    });
    return z.NEVER;
  }
  return escapeDroppedInputMappingKeys(admitted.snapshot);
});

export const workflowGraphSchema: z.ZodType<WorkflowGraph> =
  workflowGraphPreflightSchema
    .pipe(workflowGraphStructuralSchemaV1)
    .transform(restoreDroppedInputMappingKeys);
