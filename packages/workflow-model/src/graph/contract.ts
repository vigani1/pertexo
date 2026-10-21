import { workflowNotesSchema, type WorkflowNote } from './notes/contract.js';
import {
  runInputValueSourceSchema,
  expressionValueSourceSchema,
} from '../values/mapping/contract.js';
import { workspaceVariableNameSchema } from '../values/variables/contract.js';
import {
  stepRetrySettingsSchema,
  type StepRetrySettings,
} from '../execution/step-retries/contract.js';
import { z } from 'zod';

import type { JsonValue } from '../values/json/canonical.js';
import {
  callableTypeStructuralSchema,
  type CallableDeclaration,
} from '../flow/callable/contract.js';

import { hasBoundedGraphAggregateUnsafe } from './aggregate.js';
import { inspectWorkflowGraphAdmission } from './validation/admission.js';
import {
  escapeDroppedInputMappingKeys,
  restoreDroppedInputMappingKeys,
} from './input-mapping-keys.js';

export type NodeId = string;
export type ValueSource =
  | { readonly kind: 'workspace_variable'; readonly name: string }
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'run_input'; readonly path: string }
  | {
      readonly kind: 'node_output';
      readonly nodeId: NodeId;
      readonly path: string;
    }
  | {
      readonly kind: 'node_failure';
      readonly nodeId: NodeId;
      readonly path: string;
    }
  | {
      readonly kind: 'expression';
      readonly language: 'jsonata';
      readonly expression: string;
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
export interface StructuredBody extends Omit<
  WorkflowGraph,
  'callable' | 'notes'
> {
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
  readonly retry?: StepRetrySettings | undefined;
  readonly structured?: ForEachStructure | undefined;
}
export interface WorkflowGraph {
  readonly notes?: readonly WorkflowNote[] | undefined;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly settings: WorkflowSettings;
  readonly callable?: CallableDeclaration | undefined;
}

/** Static size and concurrency stay bounded independently of pruned iteration history. */
export const WORKFLOW_GRAPH_CONTRACT_LIMITS = Object.freeze({
  nodes: 200,
  edges: 4_000,
  graphBytes: 1_048_576,
  identifierLength: 64,
  maxLoopIterations: 4_998,
  maxTotalLoopIterations: 5_000,
  maxExpandedInvocations: 5_000,
  maxConcurrentInvocations: 200,
  maxLoopConcurrency: 200,
  structuredDepth: 32,
  inputDepth: 256,
});
export const WORKFLOW_EXECUTION_LIMITS = Object.freeze({
  maxRunDurationMs: 3_600_000,
});
export const WORKFLOW_VALIDATION_MAX_ISSUES = 100;

const identifierSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength);
const positiveVersionSchema = z.number().int().positive();
const jsonRecordSchema = z.record(z.string(), z.json());
const valueSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('workspace_variable'),
      name: workspaceVariableNameSchema,
    })
    .strict(),
  z.object({ kind: z.literal('literal'), value: z.json() }).strict(),
  runInputValueSourceSchema,
  z
    .object({
      kind: z.literal('node_output'),
      nodeId: identifierSchema,
      path: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('node_failure'),
      nodeId: identifierSchema,
      path: z.string(),
    })
    .strict(),
  expressionValueSourceSchema,
  z
    .object({
      kind: z.literal('structured_input'),
      port: identifierSchema,
      path: z.string(),
    })
    .strict(),
]);
const workflowSettingsSchema = z
  .object({
    maxRunDurationMs: z
      .number()
      .int()
      .positive()
      .max(WORKFLOW_EXECUTION_LIMITS.maxRunDurationMs)
      .optional(),
  })
  .strict();

const callableDeclarationSchema = z
  .object({
    input: callableTypeStructuralSchema,
    resultType: callableTypeStructuralSchema,
    result: valueSourceSchema,
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
      retry: stepRetrySettingsSchema.optional(),
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
      nodes: z.array(workflowNodeSchema),
      edges: z.array(workflowEdgeSchema),
      settings: workflowSettingsSchema,
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
export const workflowGraphStructuralSchema: z.ZodType<WorkflowGraph> = z.lazy(
  () =>
    z
      .object({
        nodes: z
          .array(workflowNodeSchema)
          .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.nodes),
        edges: z
          .array(workflowEdgeSchema)
          .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.edges),
        settings: workflowSettingsSchema,
        callable: callableDeclarationSchema.optional(),
        notes: workflowNotesSchema.optional(),
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
    .pipe(workflowGraphStructuralSchema)
    .transform(restoreDroppedInputMappingKeys);

export const EMPTY_WORKFLOW_GRAPH: WorkflowGraph = Object.freeze({
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
  settings: Object.freeze({}),
});
