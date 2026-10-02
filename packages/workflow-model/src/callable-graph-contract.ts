import { z } from 'zod';

import {
  callableObjectTypeDescriptorSchemaV1,
  type CallableObjectTypeDescriptorV1,
} from './callable-type-contract.js';
import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  WORKFLOW_VALIDATION_MAX_ISSUES,
  structuredBodySchemaV1,
  valueSourceSchema,
  workflowEdgeSchema,
  workflowNodeSchemaFor,
  workflowSettingsSchemaV1,
  type StructuredBody,
  type ValueSource,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph-contract.js';
import { inspectWorkflowGraphAdmission } from './graph/admission.js';
import { hasBoundedGraphAggregateUnsafe } from './graph/aggregate.js';
import {
  escapeDroppedInputMappingKeys,
  restoreDroppedInputMappingKeys,
} from './graph/input-mapping-keys.js';

export interface WorkflowCallableDeclarationV1 {
  readonly schemaVersion: 1;
  readonly input: CallableObjectTypeDescriptorV1;
  readonly result: CallableObjectTypeDescriptorV1;
  readonly resultSelector: ValueSource;
}

export interface WorkflowCallableGraphV2 extends WorkflowGraph {
  readonly schemaVersion: 2;
  readonly callable?: WorkflowCallableDeclarationV1 | undefined;
}

export const workflowCallableDeclarationSchemaV1: z.ZodType<WorkflowCallableDeclarationV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      input: callableObjectTypeDescriptorSchemaV1,
      result: callableObjectTypeDescriptorSchemaV1,
      resultSelector: valueSourceSchema,
    })
    .strict();

const workflowNodeSchemaV2: z.ZodType<WorkflowNode> = z.lazy(() =>
  workflowNodeSchemaFor(
    z.union([structuredBodySchemaV1, structuredBodySchemaV2]),
  ),
);

const structuredBodySchemaV2: z.ZodType<StructuredBody> = z.lazy(() =>
  z
    .object({
      schemaVersion: z.literal(2),
      nodes: z.array(workflowNodeSchemaV2),
      edges: z.array(workflowEdgeSchema),
      settings: workflowSettingsSchemaV1,
      inputPorts: z.array(z.string().min(1)),
      outputPorts: z.array(z.string().min(1)),
    })
    .strict(),
);

/** Projection only: untrusted callers must use the guarded schema below. */
export const workflowGraphStructuralSchemaV2: z.ZodType<WorkflowCallableGraphV2> =
  z.lazy(() =>
    z
      .object({
        schemaVersion: z.literal(2),
        nodes: z
          .array(workflowNodeSchemaV2)
          .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.nodes),
        edges: z
          .array(workflowEdgeSchema)
          .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.edges),
        settings: workflowSettingsSchemaV1,
        callable: workflowCallableDeclarationSchemaV1.optional(),
      })
      .strict(),
  );

const admissionLimits = {
  ...WORKFLOW_GRAPH_CONTRACT_LIMITS,
  jsonValueDepth: 64,
};

/** Explicit V2 admission; retained V1 parsing and checksum semantics are unchanged. */
export const workflowCallableGraphSchemaV2: z.ZodType<WorkflowCallableGraphV2> =
  z.unknown().transform((input, context) => {
    const admitted = inspectWorkflowGraphAdmission(input, admissionLimits, {
      allowNonFiniteNumbers: true,
    });
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
    const parsed = workflowGraphStructuralSchemaV2.safeParse(
      escapeDroppedInputMappingKeys(admitted.snapshot),
    );
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(
        0,
        WORKFLOW_VALIDATION_MAX_ISSUES,
      ))
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
      return z.NEVER;
    }
    const graph = parsed.data;
    restoreDroppedInputMappingKeys(graph);
    const selector = (admitted.snapshot as WorkflowCallableGraphV2).callable
      ?.resultSelector;
    if (selector?.kind === 'literal' && graph.callable !== undefined) {
      // Reuse the existing mapping-literal depth guard. Preserve admitted own
      // __proto__ data that structural Zod JSON records deliberately drop.
      const literalAdmission = inspectWorkflowGraphAdmission(
        { nodes: [{ inputMappings: { result: selector } }] },
        admissionLimits,
      );
      if (!literalAdmission.ok) {
        context.addIssue({
          code: 'custom',
          message: 'callable result selector exceeds the bounded JSON contract',
        });
        return z.NEVER;
      }
      return {
        ...graph,
        callable: { ...graph.callable, resultSelector: selector },
      };
    }
    return graph;
  });
